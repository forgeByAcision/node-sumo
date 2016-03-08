# node-sumo

Control your Parrot Jumping Sumo drone using JavaScript!

This module allows you to control and receive video data from the [Parrot Jumping Sumo](http://www.parrot.com/products/jumping-sumo/) WiFi controlled drone.

The implementation is heavily based on the [node-bebop](https://github.com/hybridgroup/node-bebop) from [@hybridgroup](https://github.com/hybridgroup). The Bebop and Jumping Sumo share the same underlying connection and management protocol with the following differences:
* Jumping Sumo transmits MJPEG video instead of H.264 (no iframes to worry about)
* The commands to drive the Jumping Sumo are completely different from those to fly the Bebop
* The events from the Jumping Sumo are (mostly) different from those from the Bebop

## How to Install

To get started, install the npm module:

    $ npm install git+https://github.com/forgeByAcision/node-sumo


## How to Use

This simple example postures the drone and moves it forwards for 1 second:

```javascript
var sumo = require('node-sumo');

var drone = sumo.createClient();

drone.connect(function() {
  drone.postureJumper();
  drone.forward(50);

  setTimeout(function() {
    drone.stop();
  }, 1000);
});

```
### API

#### createClient()

Returns a `new Sumo`

#### getVideoStream()

Returns a stream of MJPEG frames through the `data` event.

#### connect(callback)

Connects to the drone and executes the callback when the drone is ready to drive. Also fires the `ready` event when teh drone is ready.

#### forward(speed)

Move the drone forward at the specified speed (between 0 and 100).

#### backward(speed)

Move the drone backward at the specified speed (between 0 and 100).

#### right(speed)

Turn the drone right at the specified speed (between 0 and 100).

#### left(speed)

Turn the drone right at the specified speed (between 0 and 100).

#### stop()

Tell the drone to stop moving.

#### animationsLongJump()

Perform a long jump. The drone needs to be in the jumper or kicker posture to use this API.

When in kicker posture the first call will retract the drone's jump mechanism and the second will release it. You need to wait for the drone's jump mechanism to be fully retracted before releasing it. You can move the drone after the jump mechanism has been pulled in (for example, reversing up to a wall or object to kick) and before you release it.

#### animationsHighJump()

Perform a high jump. The drone needs to be in the jumper posture to use this API.

#### animationsStop()

Stop the pre-programmed animation.

#### animationsSpin()

Perform a spin.

#### animationsTap()

Tap the drone's jump mechanism.

#### animationsSlowShake()

Shake the drone from side-to-side.

#### animationsMetronome()

Perform the metronome animation.

#### animationsOndulation()

Perform the ondulation animation.

#### animationsSpinJump()

Spin and then jump the drone.

#### animationsSpinToPosture()

Spin and then change posture.

#### animationsSpiral()

Make the drone drive in a spiral.

#### animationsSlalom()

Make the drone drive in a slalom pattern.

#### postureStanding()

Move the drone into the standing (on head) posture.

#### postureJumper()

Move the drone into the jumper posture. The drone's jump mechanism is used to propel the drone into the air.

#### postureKicker()

Move the drone into the kicker posture. The drone's jump mechanism is used to kick objects behind the drone.

### Events

#### getVideoStream(): data

Emits the MJPEG video stream.

#### ready

Emitted when the application has connected to the drone and it is ready for commands.

#### battery

Emits the battery level percentage.

#### postureStanding

Emitted when the drone changes to the standing posture. The event may be emitted slightly before the movement is complete so you may want to wait a short time before sending the drone futher commands.

#### postureJumper

Emitted when the drone changes to the jumper posture. The event may be emitted slightly before the movement is complete so you may want to wait a short time before sending the drone futher commands.

#### postureKicker

Emitted when the drone changes to the kicker posture. The event may be emitted slightly before the movement is complete so you may want to wait a short time before sending the drone futher commands.

#### postureStuck

Emitted when the drone is stuck.

#### postureUnknown

Emitted when the drone is in an unknown position.

#### batteryCritical

Emitted when the battery is at a critically low level.

#### batteryLow

Emitted when the battery is at a low level.

#### jumpLoadUnknown

Emitted when the load state of the jump mechanism is unknown.

#### jumpLoadUnloaded

Emitted when the jump mechanism is unloaded (for example, after a jump or kick). The event may be emitted slightly before the movement is complete so you may want to wait a short time before sending the drone futher commands.

#### jumpLoadLoaded

Emitted when the jump mechanism is retracted (for example, after a long jump while in the kicker posture). The event may be emitted slightly before the movement is complete so you may want to wait a short time before sending the drone futher commands.

#### jumpLoadBusy

Emitted when the jump mechanism is busy (for example, if you tell the drone to jump while a jump is already in progress).

#### jumpLoadLowBatteryUnloaded

Emitted when the jump mechanism is unloaded and the drone cannot perform the jump requested because the battery is low.

#### jumpLoadLowBatteryLoaded

Emitted when the jump mechanism is unloaded and the drone cannot perform the jump requested because the battery is low.

#### jumpMotorOK

Emitted when the jump motor is OK (it may have previously been blocked or overheated).

#### jumpMotorErrorBlocked

Emitted when the jump motor is blocked.

#### jumpMotorErrorOverheated

Emitted when the jump motor has overheated.

#### video

Emits single MJPEG video frame

## Release History

0.0.1 Initial release

## License

Copyright (c) 2015 Acision. Licensed under the MIT license.
