"use strict";

var EventEmitter = require("events").EventEmitter,
    dgram = require("dgram"),
    util = require("util"),
    net = require("net"),
    through = require("through"),
    constants = require("./constants");

function networkFrameGenerator() {
  //
  // ARNETWORKAL_Frame_t
  //
  // uint8  type  - frame type ARNETWORK_FRAME_TYPE
  // uint8  id    - identifier of the buffer sending the frame
  // uint8  seq   - sequence number of the frame
  // uint32 size  - size of the frame
  //

  // each frame id has it"s own sequence number
  var seq = [];

  return function(cmd, type, id) {
    var hlen = 7, // size of ARNETWORKAL_Frame_t header
        buf = new Buffer(hlen);

    type = type || constants.ARNETWORKAL_FRAME_TYPE_DATA;
    id = id || constants.BD_NET_CD_NONACK_ID;

    if (!seq[id]) {
      seq[id] = 0;
    }

    seq[id]++;

    if (seq[id] > 255) {
      seq[id] = 0;
    }

    buf.writeUInt8(type, 0);
    buf.writeUInt8(id, 1);
    buf.writeUInt8(seq[id], 2);
    buf.writeUInt32LE(cmd.length + hlen, 3);

    return Buffer.concat([buf, cmd]);
  };
}

function networkFrameParser(buf) {
  var frame = {
    type: buf.readUInt8(0),
    id: buf.readUInt8(1),
    seq: buf.readUInt8(2),
    size: buf.readUInt32LE(3)
  };

  if (frame.size > 7) {
    frame.data = Buffer.concat([buf.slice(7, frame.size)]);
  }

  return frame;
}

function arstreamFrameParser(buf) {
  //
  // ARSTREAM_NetworkHeaders_DataHeader_t;
  //
  // uint16_t frameNumber;
  // uint8_t  frameFlags; // Infos on the current frame
  // uint8_t  fragmentNumber; // Index of the current fragment in current frame
  // uint8_t  fragmentsPerFrame; // Number of fragments in current frame
  //
  // * frameFlags structure :
  // *  x x x x x x x x
  // *  | | | | | | | \-> FLUSH FRAME
  // *  | | | | | | \-> UNUSED
  // *  | | | | | \-> UNUSED
  // *  | | | | \-> UNUSED
  // *  | | | \-> UNUSED
  // *  | | \-> UNUSED
  // *  | \-> UNUSED
  // *  \-> UNUSED
  // *
  //

  var frame = {
    frameNumber: buf.readUInt16LE(0),
    frameFlags: buf.readUInt8(2),
    fragmentNumber: buf.readUInt8(3),
    fragmentsPerFrame: buf.readUInt8(4),
  };

  frame.frame = Buffer.concat([buf.slice(5)]);

  return frame;
}

var Sumo = module.exports = function(opts) {
  opts = opts || {};
  this.navData = {};
  this.ip = opts.ip || "192.168.2.1";
  this.c2dPort = opts.c2dPort || 54321;
  this.d2cPort = opts.d2cPort || 43210;
  this.discoveryPort = opts.discoveryPort || 44444;
  this._c2dClient = dgram.createSocket("udp4");
  this._d2cServer = dgram.createSocket("udp4");
  this._discoveryClient = new net.Socket();
  this._networkFrameGenerator = networkFrameGenerator();
  this._arstreamFrame = {
    frameNumber: 0,
    frame: new Buffer([]),
    fragments: [],
  };
  this._pcmd = {};
};

util.inherits(Sumo, EventEmitter);

Sumo.prototype.getVideoStream = function() {
  var stream = through(function write(data) {
    this.emit("data", data);
  });

  this.on("video", function(data) {
    stream.write(data);
  });

  return stream;
};

Sumo.prototype.connect = function(callback) {
  this.discover(function() {

    // nav and video
    this._d2cServer.bind(this.d2cPort);
    this._d2cServer.on("message", this._packetReceiver.bind(this));

    // send pcmd values at 40hz
    setInterval(function() {
      this._writePacket(this._generatePCMD(this._pcmd));
    }.bind(this), 25);

    this.generateAllStates();

    if (typeof callback === "function") {
      callback();
    }

    this.emit("ready");
  }.bind(this));
};

Sumo.prototype.discover = function(callback) {
  this._discoveryClient.connect(this.discoveryPort, this.ip, function() {
    this._discoveryClient.write(JSON.stringify({
      "controller_type": "computer",
      "controller_name": "node-sumo",
      "d2c_port": this.d2cPort.toString()
    }));
  }.bind(this));

  this._discoveryClient.on("data", function(data) {
    this._discoveryClient.destroy();
    callback(data);
  }.bind(this));
};

Sumo.prototype._packetReceiver = function(message) {
  var networkFrame = networkFrameParser(message);

  //
  // libARNetwork/Sources/ARNETWORK_Receiver.c#ARNETWORK_Receiver_ThreadRun
  //
  if (networkFrame.type === constants.ARNETWORKAL_FRAME_TYPE_DATA_WITH_ACK) {
    this._writePacket(this._createAck(networkFrame));
  }

  if (networkFrame.type === constants.ARNETWORKAL_FRAME_TYPE_DATA_LOW_LATENCY &&
      networkFrame.id === constants.BD_NET_DC_VIDEO_DATA_ID)
  {
    var arstreamFrame = arstreamFrameParser(networkFrame.data);
    this._writePacket(this._createARStreamACK(arstreamFrame));
  }



  //
  // libARCommands/Sources/ARCOMMANDS_Decoder.c#ARCOMMANDS_Decoder_DecodeBuffer
  //
  if (networkFrame.id === constants.BD_NET_DC_EVENT_ID) {
    var commandProject = networkFrame.data.readUInt8(0),
        commandClass = networkFrame.data.readUInt8(1),
        commandId = networkFrame.data.readUInt16LE(2);
    switch (commandProject) {
      case constants.ARCOMMANDS_ID_PROJECT_COMMON:
        switch (commandClass) {
          case constants.ARCOMMANDS_ID_COMMON_CLASS_COMMONSTATE:
            switch (commandId) {
              case constants.ARCOMMANDS_ID_COMMON_COMMONSTATE_CMD_BATTERYSTATECHANGED:
                this.navData.battery = networkFrame.data.readUInt8(4);
                this.emit("battery", this.navData.battery);
                break;
              case constants.ARCOMMANDS_ID_COMMON_COMMONSTATE_CMD_ALLSTATESCHANGED:
              case constants.ARCOMMANDS_ID_COMMON_COMMONSTATE_CMD_MASSSTORAGESTATELISTCHANGED:
              case constants.ARCOMMANDS_ID_COMMON_COMMONSTATE_CMD_MASSSTORAGEINFOSTATELISTCHANGED:
                break;
              default:
                console.log("Unhandled COMMON_CLASS_COMMONSTATE commandId: " + commandId);
                break;
            }
            break;
          default:
            console.log("Unhandled PROJECT_COMMON commandClass: " + commandClass + ", commandId: " + commandId);
            break;
        }
        break;
      case constants.ARCOMMANDS_ID_PROJECT_JUMPINGSUMO:
        switch (commandClass) {
          case constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_PILOTINGSTATE:
            switch (commandId) {
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_PILOTINGSTATE_CMD_POSTURECHANGED:
                var state = networkFrame.data.readInt32LE(4);
                switch(state) {
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_POSTURECHANGED_STATE_STANDING:
                    this.navData.posture = { standing: true };
                    this.emit("postureStanding");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_POSTURECHANGED_STATE_JUMPER:
                    this.navData.posture = { jumper: true };
                    this.emit("postureJumper");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_POSTURECHANGED_STATE_KICKER:
                    this.navData.posture = { kicker: true };
                    this.emit("postureKicker");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_POSTURECHANGED_STATE_STUCK:
                    this.navData.posture = { stuck: true };
                    this.emit("postureStuck");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_POSTURECHANGED_STATE_UNKNOWN:
                    this.navData.posture = { unknown: true };
                    this.emit("postureUnknown");
                    break;
                  default:
                    console.log("Unhandled JUMPINGSUMO_PILOTINGSTATE_POSTURECHANGED_STATE state: " + state);
                    break;
                }
                break;
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_PILOTINGSTATE_CMD_ALERTSTATECHANGED:
                var state = networkFrame.data.readInt32LE(4);
                switch(state) {
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_ALERTSTATECHANGED_STATE_NONE:
                    this.navData.alertState = {};
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_ALERTSTATECHANGED_STATE_CRITICAL_BATTERY:
                    this.navData.alertState = { batteryCritical: true };
                    this.emit("batteryCritical");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_PILOTINGSTATE_ALERTSTATECHANGED_STATE_LOW_BATTERY:
                    this.navData.alertState = { batteryLow: true };
                    this.emit("batteryLow");
                    break;
                  default:
                    console.log("Unhandled JUMPINGSUMO_PILOTINGSTATE_ALERTSTATECHANGED_STATE state: " + state);
                    break;
                }
                break;
              default:
                console.log("Unhandled JUMPINGSUMO_CLASS_PILOTINGSTATE commandId: " + commandId);
                break;
            }
            break;
          case constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_ANIMATIONSSTATE:
            switch (commandId) {
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_ANIMATIONSSTATE_CMD_JUMPLOADCHANGED:
                var state = networkFrame.data.readInt32LE(4);
                switch(state) {
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE_UNKNOWN:
                    this.navData.jumpLoad = { unknown: true };
                    this.emit("jumpLoadUnknown");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE_UNLOADED:
                    this.navData.jumpLoad = { unloaded: true };
                    this.emit("jumpLoadUnloaded");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE_LOADED:
                    this.navData.jumpLoad = { loaded: true };
                    this.emit("jumpLoadLoaded");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE_BUSY:
                    this.navData.jumpLoad = { busy: true };
                    this.emit("jumpLoadBusy");
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE_LOW_BATTERY_UNLOADED:
                    this.navData.jumpLoad = { lowBatteryUnloaded: true };
                    this.emit("jumpLoadLowBatteryUnloaded");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE_LOW_BATTERY_LOADED:
                    this.navData.jumpLoad = { lowBatteryLoaded: true };
                    this.emit("jumpLoadLowBatteryLoaded");
                    break;
                  default:
                    console.log("Unhandled JUMPINGSUMO_ANIMATIONSSTATE_JUMPLOADCHANGED_STATE state: " + state);
                    break;
                }
                break;
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_ANIMATIONSSTATE_CMD_JUMPMOTORPROBLEMCHANGED:
                var error = networkFrame.data.readInt32LE(4);
                switch(error) {
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPMOTORPROBLEMCHANGED_ERROR_NONE:
                    this.navData.jumpMotorError = {};
                    this.emit("jumpMotorOK");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPMOTORPROBLEMCHANGED_ERROR_BLOCKED:
                    this.navData.jumpMotorError = { blocked: true };
                    this.emit("jumpMotorErrorBlocked");
                    break;
                  case constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONSSTATE_JUMPMOTORPROBLEMCHANGED_ERROR_OVER_HEATED:
                    this.navData.jumpMotorError = { overheated: true};
                    this.emit("jumpMotorErrorOverheated");
                    break;
                  default:
                    console.log("Unhandled JUMPINGSUMO_ANIMATIONSSTATE_JUMPMOTORPROBLEMCHANGED_ERROR error: " + error);
                    break;
                }
                break;
              default:
                console.log("Unhandled JUMPINGSUMO_CLASS_ANIMATIONSSTATE commandId: " + commandId);
                break;
            }
            break;
          case constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_NETWORKSTATE:
            switch (commandId) {
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_NETWORKSTATE_CMD_LINKQUALITYCHANGED:
                break;
              default:
                console.log("Unhandled JUMPINGSUMO_CLASS_NETWORKSTATE commandId: " + commandId);
                break;
            }
            break;
          case constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_MEDIASTREAMINGSTATE:
            switch (commandId) {
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_MEDIASTREAMINGSTATE_CMD_VIDEOENABLECHANGED:
                break;
              default:
                console.log("Unhandled JUMPINGSUMO_CLASS_MEDIASTREAMINGSTATE commandId: " + commandId);
                break;
            }
            break;
          case constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_MEDIARECORDSTATE:
            switch(commandId) {
              case constants.ARCOMMANDS_ID_JUMPINGSUMO_MEDIARECORDSTATE_CMD_PICTURESTATECHANGED:
                this.emit("internalPicture");
                break;
            }
            break;
          default:
            console.log("Unhandled PROJECT_JUMPINGSUMO commandClass: " + commandClass + ", commandId: " + commandId);
            break;
        }
        break;
      default:
        console.log("Unhandled commandProject: " + commandProject + ", commandClass: " + commandClass + ", commandId: " + commandId);
        break;
    }
  }

  //
  // libARNetwork/Sources/ARNETWORK_Receiver.c#ARNETWORK_Receiver_ThreadRun
  //
  if (networkFrame.id === constants.ARNETWORK_MANAGER_INTERNAL_BUFFER_ID_PING) {
    this.navData.runningTime = networkFrame.data.readUInt32LE(0) + (networkFrame.data.readUInt32LE(4) / 1000000000.0);
    this._writePacket(this._createPong(networkFrame));
  }
};


// Transplanted from node-bebop project
Sumo.prototype.takePicture = function(opts)
{
  //
  // ARCOMMANDS_Generator_GenerateARDrone3MediaRecordPicture
  //

  var buf = new Buffer(5);

  opts = opts || {};
  opts.storageId = opts.storageId || 0;

  buf.writeUInt8(constants.ARCOMMANDS_ID_PROJECT_JUMPINGSUMO, 0);
  buf.writeUInt8(constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_MEDIARECORD, 1);
  buf.writeUInt16LE(constants.ARCOMMANDS_ID_JUMPINGSUMO_MEDIARECORD_CMD_PICTURE, 2);
  buf.writeUInt8(opts.storageId, 4);

  this._writePacket(this._networkFrameGenerator(buf));
  return this;
};


Sumo.prototype.forward = function(val) {
  this._pcmd = {
    flag: 1,
    speed: validate_val(val),
  };
  return this;
}

Sumo.prototype.backward = function(val) {
  this._pcmd = {
    flag: 1,
    speed: validate_val(val) * -1,
  };
  return this;
}

Sumo.prototype.right = function (val) {
  this._pcmd = {
    flag: 1,
    turn: validate_val(val),
  };
  return this;
}

Sumo.prototype.left = function (val) {
  this._pcmd = {
    flag: 1,
    turn: validate_val(val) * -1,
  };
  return this;
}

Sumo.prototype.stop = function() {
  this._pcmd = {
    flag: 0,
    speed: 0,
    turn: 0,
  };
  return this;
}

function validate_val(val) {
  if (val > 100) {
    return 100;
  } else if (val < 0) {
    return 0;
  }

  return val | 0;
}

Sumo.prototype.animationsLongJump = function() {
  return this._animationsJump(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_JUMP_TYPE_LONG);
}

Sumo.prototype.animationsHighJump = function() {
  return this._animationsJump(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_JUMP_TYPE_HIGH);
}

Sumo.prototype.animationsStop = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_STOP);
}

Sumo.prototype.animationsSpin = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_SPIN);
}

Sumo.prototype.animationsTap = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_TAP);
}

Sumo.prototype.animationsSlowShake = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_SLOWSHAKE);
}

Sumo.prototype.animationsMetronome = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_METRONOME);
}

Sumo.prototype.animationsOndulation = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_ONDULATION);
}

Sumo.prototype.animationsSpinJump = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_SPINJUMP);
}

Sumo.prototype.animationsSpinToPosture = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_SPINTOPOSTURE);
}

Sumo.prototype.animationsSpiral = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_SPIRAL);
}

Sumo.prototype.animationsSlalom = function() {
  return this._animationsSimpleAnimation(constants.ARCOMMANDS_JUMPINGSUMO_ANIMATIONS_SIMPLEANIMATION_ID_SLALOM);
}

Sumo.prototype.postureStanding = function() {
  return this._posture(constants.ARCOMMANDS_JUMPINGSUMO_PILOTING_POSTURE_TYPE_STANDING);
}

Sumo.prototype.postureJumper = function() {
  return this._posture(constants.ARCOMMANDS_JUMPINGSUMO_PILOTING_POSTURE_TYPE_JUMPER);
}

Sumo.prototype.postureKicker = function() {
  return this._posture(constants.ARCOMMANDS_JUMPINGSUMO_PILOTING_POSTURE_TYPE_KICKER);
}

Sumo.prototype._animationsJump = function(type) {
  //
  //  ARCOMMANDS_Generator_GenerateJumpingSumoAnimationsJump
  //
  // uint32 - type ???

  var buf = new Buffer(8);

  buf.writeUInt8(constants.ARCOMMANDS_ID_PROJECT_JUMPINGSUMO, 0);
  buf.writeUInt8(constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_ANIMATIONS, 1);
  buf.writeUInt16LE(constants.ARCOMMANDS_ID_JUMPINGSUMO_ANIMATIONS_CMD_JUMP, 2);
  buf.writeUInt32LE(type, 4);

  this._writePacket(this._networkFrameGenerator(buf));
  return this;
};

Sumo.prototype._animationsSimpleAnimation = function(id) {
  //
  //  ARCOMMANDS_Generator_GenerateJumpingSumoAnimationsSimpleAnimation
  //
  // uint32 - id ???

  var buf = new Buffer(8);

  buf.writeUInt8(constants.ARCOMMANDS_ID_PROJECT_JUMPINGSUMO, 0);
  buf.writeUInt8(constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_ANIMATIONS, 1);
  buf.writeUInt16LE(constants.ARCOMMANDS_ID_JUMPINGSUMO_ANIMATIONS_CMD_SIMPLEANIMATION, 2);
  buf.writeUInt32LE(id, 4);

  this._writePacket(this._networkFrameGenerator(buf));
  return this;
};

Sumo.prototype._posture = function(type) {
  //
  //  ARCOMMANDS_Generator_GenerateJumpingSumoPilotingPosture
  //
  // uint32 - type ???

  var buf = new Buffer(8);

  buf.writeUInt8(constants.ARCOMMANDS_ID_PROJECT_JUMPINGSUMO, 0);
  buf.writeUInt8(constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_PILOTING, 1);
  buf.writeUInt16LE(constants.ARCOMMANDS_ID_JUMPINGSUMO_PILOTING_CMD_POSTURE, 2);
  buf.writeUInt32LE(type, 4);

  this._writePacket(this._networkFrameGenerator(buf));
  return this;
};

Sumo.prototype.generateAllStates = function() {
  //
  // ARCOMMANDS_Generator_GenerateCommonCommonAllStates
  //

  var buf = new Buffer(4);

  buf.writeUInt8(constants.ARCOMMANDS_ID_PROJECT_COMMON, 0);
  buf.writeUInt8(constants.ARCOMMANDS_ID_COMMON_CLASS_COMMON, 1);
  buf.writeUInt16LE(constants.ARCOMMANDS_ID_COMMON_COMMON_CMD_ALLSTATES, 2);

  this._writePacket(this._networkFrameGenerator(buf));
  return this;
};

Sumo.prototype._createAck = function(networkFrame) {
  var buf = new Buffer(1);

  //
  // ARNETWORK_Receiver_ThreadRun
  //
  buf.writeUInt8(networkFrame.seq, 0);

  //
  //
  // libARNetwork/Sources/ARNETWORK_Manager.h#ARNETWORK_Manager_IDOutputToIDAck
  //
  var id = networkFrame.id + (constants.ARNETWORKAL_MANAGER_DEFAULT_ID_MAX / 2);

  return this._networkFrameGenerator(buf, constants.ARNETWORKAL_FRAME_TYPE_ACK, id);
};

Sumo.prototype._createPong = function(networkFrame) {
  return this._networkFrameGenerator(networkFrame.data, constants.ARNETWORKAL_FRAME_TYPE_DATA, constants.ARNETWORK_MANAGER_INTERNAL_BUFFER_ID_PONG);
};

Sumo.prototype._createARStreamACK = function(arstreamFrame) {
  //
  // ARSTREAM_NetworkHeaders_AckPacket_t;
  //
  // uint16_t frameNumber;    // id of the current frame
  // uint64_t highPacketsAck; // Upper 64 packets bitfield
  // uint64_t lowPacketsAck;  // Lower 64 packets bitfield
  //
  // libARStream/Sources/ARSTREAM_NetworkHeaders.c#ARSTREAM_NetworkHeaders_AckPacketSetFlag
  //

  if (arstreamFrame.frameNumber !== this._arstreamFrame.frameNumber) {
    if (this._arstreamFrame.fragments.length > 0) {
      // Jumping Sumo transmits MJPEG so no iframes to detect or wait for.
      // Just send out complete JPEG frames as soon as they are received.
      var skip = false;
      for (var i = 0; i < this._arstreamFrame.fragments.length; i++) {
        // check if any fragments are missing
        if (!Buffer.isBuffer(this._arstreamFrame.fragments[i])) {
          skip = true;
          break;
        }
        this._arstreamFrame.frame = Buffer.concat([this._arstreamFrame.frame, this._arstreamFrame.fragments[i]]);
      }

      if (!skip) {
        this.emit("video", this._arstreamFrame.frame);
      }
    }

    this._arstreamFrame.fragments = [];
    this._arstreamFrame.frame = new Buffer(0);
    this._arstreamFrame.frameACK = new Buffer(16);
    this._arstreamFrame.frameACK.fill(0);
    this._arstreamFrame.frameNumber = arstreamFrame.frameNumber;
    this._arstreamFrame.frameFlags = arstreamFrame.frameFlags;
  }

  this._arstreamFrame.fragments[arstreamFrame.fragmentNumber] = Buffer.concat([arstreamFrame.frame]);

  //
  // each bit in the highPacketsAck and lowPacketsAck correspond to the
  // fragmentsPerFrame which have been received per frameNumber, so time to
  // flip some bits!
  //

  var bufferPosition = arstreamFrame.fragmentNumber / 8 | 0;
  var tmp = this._arstreamFrame.frameACK.readUInt8(bufferPosition);

  tmp |= 1 << (arstreamFrame.fragmentNumber % 8);

  this._arstreamFrame.frameACK.writeUInt8(tmp, bufferPosition);

  // lowPacketsAck and highPacketsAck are stored contiguously
  // in a 16 byte buffer and then reordered accordingly for transport
  var ackPacket = {
    frameNumber: this._arstreamFrame.frameNumber,
    packetsACK: Buffer.concat([this._arstreamFrame.frameACK.slice(8), this._arstreamFrame.frameACK.slice(0, 8)]),
  };

  var ret = new Buffer(18);
  ret.fill(0);
  ret.writeUInt16LE(ackPacket.frameNumber, 0);
  ackPacket.packetsACK.copy(ret, 2);

  return this._networkFrameGenerator(ret, constants.ARNETWORKAL_FRAME_TYPE_DATA, constants.BD_NET_CD_VIDEO_ACK_ID);
};

Sumo.prototype._generatePCMD = function(opts) {
  //
  // ARCOMMANDS_Generator_GenerateJumpingSumoPilotingPCMD
  //
  // uint8 - flag ???
  // int8  - speed ???
  // int8  - turn ???
  //

  var buf = new Buffer(7);

  this._pcmd = opts || {};

  buf.writeUInt8(constants.ARCOMMANDS_ID_PROJECT_JUMPINGSUMO, 0);
  buf.writeUInt8(constants.ARCOMMANDS_ID_JUMPINGSUMO_CLASS_PILOTING, 1);
  buf.writeUInt16LE(constants.ARCOMMANDS_ID_JUMPINGSUMO_PILOTING_CMD_PCMD, 2);
  buf.writeUInt8(this._pcmd.flag || 1, 4);
  buf.writeInt8(this._pcmd.speed || 0, 5);
  buf.writeInt8(this._pcmd.turn || 0, 6);

  return this._networkFrameGenerator(buf);
};

Sumo.prototype._writePacket = function(packet) {
  this._c2dClient.send(packet, 0, packet.length, this.c2dPort, this.ip,
    function(err) {
      if (err) {
        throw err;
      }
    }
  );
};
