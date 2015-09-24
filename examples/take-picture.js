"use strict";

// Tests the picture taking function. Opens up a HTTP server to receive commands
// (e.g., to take the picture).

var sumo = require('../.');
var drone = sumo.createClient();

console.log();
console.log("Starting Take Picture Test");

drone.connect(function() {
  console.log("Connected...");
  drone.postureJumper();
  drone.animationsTap();
});

drone.on("battery", function(battery) {
  console.log("battery: " + battery);
});

drone.on("internalPicture", function() {
  console.log();
  console.log("A picture was saved into the drone's internal memory!");
});


function sendResponse(rsp, code, reply)
{
   rsp.writeHead(code, {'Content-Type': 'text/plain'});
   rsp.end(reply + "\n");
   console.log(reply);
}

function readRequest(req, rsp)
{
   console.log();
   console.log("New request from " + req.connection.remoteAddress);

   var verb = req.url.replace(/\//, "");
   if(verb.length <= 0)
   {
      sendResponse(rsp, 404, "No command was given.");
      return;
   }

   var array = verb.split("/");
   var reply = "";

   console.log("Full URL: " + req.url);
   console.log("Tokens  : " + array);

   switch(array.shift())
   {
      case "take-picture":
         drone.takePicture();
         sendResponse(rsp, 200, "Drone will take a picture and save it internally");
         return;

      case "favicon.ico":
         return;

      case "exit":
         sendResponse(rsp, 200, "Bye bye cruel world.... :(");
         process.exit();
         return;

      default:
         sendResponse(rsp, 404, "\"" + verb + "\" is not a known command!");
         break;
   }

   sendResponse(rsp, 503, "Woopsie! This shouldn't happen!");
}

var http = require('http');
var server = http.createServer(readRequest);

server.listen(12341, function() {
  console.log('Listening for commands on 12341 ...');
});
