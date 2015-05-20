/*
 * @author: Thabungba Meetei 
 * 
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 */

var path = require('path');
var express = require('express');
var ws = require('ws');
var minimist = require('minimist');
var url = require('url');
var kurento = require('kurento-client');
var incomingMedia = {};
var argv = minimist(process.argv.slice(2),
        {
            default:
                    {
                        as_uri: "http://localhost:8081/",
                        ws_uri: "ws://localhost:8888/kurento"

                    }
        });

var app = express();


/*
 * Definition of global variables.
 */

var idCounter = 0;
var master = null;
var pipeline = null;
var viewers = {};
var kurentoClient = null;

function nextUniqueId() {
    idCounter++;
    return idCounter.toString();
}

/*
 * Server startup
 */

var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = app.listen(port, function () {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server: server,
    path: '/call'
});

/*
 * Management of WebSocket messages
 */
wss.on('connection', function (ws) {

    var sessionId = nextUniqueId();

    console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function (error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function () {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function (_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {

            case 'joinRoom':

                joinRoom(sessionId,message.name, ws,message.room);
                break;
            case 'receiveVideoFrom':
                receiveVideoFrom(userSession, message.sender, message.sdpOffer, function (error, sdpAnswer) {
                    if (error) {
                        console.log(error);

                    }
                    data = {
                        id: 'receiveVideoAnswer',
                        name: message.sender,
                        sdpAnswer: sdpAnswer
                    };
                    return ws.send(JSON.stringify(data));
                });

                break;

            case 'stop':
                stop(sessionId);
                break;
            case 'leaveRoom':
                stop(sessionId);
                break;

            default:
                ws.send(JSON.stringify({
                    id: 'error',
                    message: 'Invalid message ' + message
                }));
                break;
        }
    });
});


function receiveVideoFrom(currentUser, senderName, sdp, callback)
{
    var sender = userRegistry.getByName(senderName);
    if (pipeline === null) {
        getKurentoClient(function (error, kurentoClient) {
            kurentoClient.create('MediaPipeline', function (error, _pipeline) {
                if (error) {
                    return callback(error);
                }
                pipeline = _pipeline;
                pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {

                    if (error) {
                        console.log(error);
                    }
                    currentUser.webRTCEndpoint = webRtcEndpoint;
                    userRegistry.usersById[currentUser.id] = currentUser;
                    userRegistry.usersByName[currentUser.name] = currentUser;
                    incomingMedia[currentUser.name] = webRtcEndpoint;
                    console.log("Created Pipeline & rtcEndpoint");
                    webRtcEndpoint.processOffer(sdp, function (error, sdpAnswer) {
                        callback(null, sdpAnswer);
                    });
                });
            }
            )
        });
    } else {
        console.log("Sender name::" + sender.name);
        senderName = sender.name;
        if (incomingMedia[senderName]) {

            pipeline.create('WebRtcEndpoint', function (err, webRtcEndpoint) {

                webRtcEndpoint.processOffer(sdp, function (err, sdpAnswer) {
                    incomingMedia[senderName].connect(webRtcEndpoint, function () {
                        callback(null, sdpAnswer);
                    });


                });
            });

        } else {
            pipeline.create('WebRtcEndpoint', function (error, webRtcEndpoint) {
                if (error) {
                    console.log(error);
                }
                incomingMedia[sender.name] = webRtcEndpoint;
                sender.webRTCEndpoint = webRtcEndpoint;
                userRegistry.usersById[sender.id] = sender;
                userRegistry.usersByName[sender.name] = sender;
                webRtcEndpoint.processOffer(sdp, function (err, sdpAnswer) {
                    if (err) {
                        console.log(err);
                    }
                    callback(null, sdpAnswer);
                });
                notifyOthers(currentUser.name);
            });

        }
    }
}



function notifyOthers(newParticipant)
{
    var myRoom = userSession.room;
    
    if (userRegistry) {
        var peers = userRegistry.getUsersByRoom(myRoom);
        for (var i in peers) {
            peer = peers[i];
            console.log(peer.name);
            if (peer.name !== newParticipant && peer.ws!==undefined) {
                console.log("Notifying " + peer.name +"===SOCKET::"+ peer.ws);
                peer.ws.send(JSON.stringify({
                    id: 'newParticipantArrived',
                    name: newParticipant
                }));
            }
        }
    }
}

// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function (error, _kurentoClient) {
        if (error) {
            console.log("Coult not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}




function stop(id, ws) {
    userRegistry.unregister(id);
}



function joinRoom(sessionId,name,ws,room) {
    register(sessionId, name, ws,room);
}

var userSession = null;
function register(id, name, ws,room, callback) {
    function onError(error) {
        console.log("Error processing register: " + error);
        ws.send(JSON.stringify({id: 'registerResponse', response: 'rejected ', message: error}));
    }

    if (!name) {
        return onError("empty user name");
    }

    if (userRegistry.getByName(name)) {
        return onError("already registered");
    }
    userSession = new UserSession(id, name, ws,room);
    userRegistry.register(userSession);
    try {
//		ws.send(JSON.stringify({id: 'registerResponse', response: 'accepted'}));
        var participants = [];
        if (userRegistry) {
            participantsName = userRegistry.getUsersByRoom(room);
            for (var i in participantsName) {
                if (name === participantsName[i].name || participantsName[i].name == "") {
                    continue;
                }
                participants.push(participantsName[i].name);
            }


        }
       
        ws.send(JSON.stringify({id: "existingParticipants", data: participants}));

    } catch (exception) {
        onError(exception);
    }
}


//Represents registrar of users
function UserRegistry() {
    this.usersById = {};
    this.usersByName = {};
}

UserRegistry.prototype.register = function (user) {
    this.usersById[user.id] = user;
    this.usersByName[user.name] = user;
}

UserRegistry.prototype.unregister = function (id) {
    var user = this.getById(id);
    if (user)
        delete this.usersById[id]
    if (user && this.getByName(user.name))
        delete this.usersByName[user.name];
    
    
}

UserRegistry.prototype.getById = function (id) {
    return this.usersById[id];
}

UserRegistry.prototype.getByName = function (name) {
    return this.usersByName[name];
}

UserRegistry.prototype.removeById = function (id) {
    var userSession = this.usersById[id];
    if (!userSession)
        return;
    delete this.usersById[id];
    delete this.usersByName[userSession.name];
}

UserRegistry.prototype.getUsersByRoom = function (room) {
    var userList = this.usersByName;
    var usersInRoomList = [];
    for(var i in userList) {
        if (userList[i].room === room) {
            usersInRoomList.push(userList[i]);
        }
    }

    return usersInRoomList;
}
var userRegistry = new UserRegistry();


function UserSession(id, name, ws,room) {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.sdpOffer = null;
    this.webRTCEndpoint = null;
    this.room = room;
}

UserSession.prototype.sendMessage = function (message) {
    this.ws.send(JSON.stringify(message));
}

app.use(express.static(path.join(__dirname, 'static')));
