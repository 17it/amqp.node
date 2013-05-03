// The river sweeps through
// Silt and twigs, gravel and leaves
// Driving the wheel on

/*
Frame format:

0      1         3             7                size+7 size+8
+------+---------+-------------+ +------------+ +-----------+
| type | channel | size        | | payload    | | frame-end |
+------+---------+-------------+ +------------+ +-----------+
 octet   short     long            size octets    octet

In general I want to know those first three things straight away, so I
can discard frames early.

*/

var constants = require('./defs').constants;
var methodFor = require('./defs').methodFor;
var propertiesFor = require('./defs').propertiesFor;

var FRAME_METHOD = constants.FRAME_METHOD,
    HEARTBEAT = constants.HEARTBEAT,
    FRAME_HEADER = constants.FRAME_HEADER,
    FRAME_BODY = constants.FRAME_BODY,
    FRAME_END = constants.FRAME_END;

var Bits = require('bitsyntax');
var Stream = require('stream');
var Duplex = require('stream').Duplex || require('readable-stream/duplex');

var FRAME_OVERHEAD = 8;

function wrapStream(s) {
    if (s instanceof Duplex) return s;
    else {
        var ws = new Duplex();
        ws.wrap(s);
        return ws;
    }     
}

/*
Sending and receiving frames, given a duplex byte stream
*/
function Frames(stream) {
    this.stream = wrapStream(stream);
    this.rest = new Buffer([]);
    this.frameMax = constants.FRAME_MIN_SIZE;
}

var F = Frames.prototype;

// low-level API

// This changed between versions, as did the codec, methods, etc. AMQP
// 0-9-1 is fairly similar to 0.8, but better, and nothing implements
// 0.8 that doesn't implement 0-9-1. In other words, it doesn't make
// much sense to generalise here.
F.sendProtocolHeader = function() {
  this.stream.write("AMQP" + String.fromCharCode(0, 0, 9, 1));
};

F.sendMethod = function(channel, method) {
    var frame = method.encodeToFrame(channel);
    return this.stream.write(frame);
};

F.sendContent = function(channel, method, header, body) {
    var writeResult = true;
    var methodFrame = method.encodeToFrame(channel);
    var headerFrame = header.encodeToFrame(channel);
    // I'll send the headers regardless
    this.stream.write(methodFrame);
    writeResult = this.stream.write(headerFrame);

    var maxBody = this.frameMax - FRAME_OVERHEAD;
    for (var offset = 0; i < body.length; offset += maxBody) {
        var end = offset + maxBody;
        var slice = (end > body.length) ? body.slice(offset) : body.slice(offset, end);
        var bodyFrame = makeBodyFrame(channel, slice);
        writeResult = this.stream.write(bodyFrame);
    }
    return writeResult;
};

var bodyCons =
    Bits.constructor([FRAME_BODY,
                      'channel:16, size:32, payload/binary',
                      FRAME_END].join(','));
// %%% TESTME possibly better to cons the first bit and write the
// second directly, in the absence of IO lists
function makeBodyFrame(channel, payload) {
    return bodyCons({channel: channel, size: payload.length, payload: payload});
}

var framePattern = Bits.compile(['type:8, channel:16, size:32, payload:size/binary',
                                 FRAME_END, 'rest/binary'].join(','));
var methodPattern = Bits.compile('id:32, args/binary');

F.recvFrame = function() { /// %%% callback arg for reinstating a read loop on 'readable'?
    // %%% identifying invariants might help here?
    var frame = framePattern(this.rest);
    if (!frame) {
        var incoming = this.stream.read();
        if (incoming === null) {
            return false;
        }
        else {
            this.rest = Buffer.concat([this.rest, incoming]);
            return this.recvFrame();
        }
    }
    else {
        this.rest = frame.rest;
        return decodeFrame(frame);
    }
};

function Heartbeat() {}
var heartbeat = new Heartbeat();

var headerPattern = Bits.compile('class:16, _weight:16, size:64, flagsAndfields/binary');

function decodeFrame(frame) {
    var payload = frame.payload;
    switch (frame.type) {
    case FRAME_METHOD:
        var idAndArgs = methodPattern(payload);
        var Method = methodFor(idAndArgs.id);
        var method = Method.fromBuffer(idAndArgs.args);
        method.channel = frame.channel;
        return method;
    case FRAME_HEADER:
        var parts = headerPattern(payload);
        var Properties = propertiesFor(parts['class']);
        var props = Properties.fromBuffer(parts.flagsAndfields);
        props.channel = frame.channel;
        props.size = parts.size;
        return props;
    case FRAME_BODY:
        return ; // %%% FIXME
    case HEARTBEAT:
        return heartbeat;
    default:
        throw new Error('Unknown frame type ' + frame.type);
    }
}

module.exports = Frames;
module.exports.Heartbeat = Heartbeat;
