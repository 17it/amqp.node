//
//
//

// Channel machinery.

var defs = require('./defs');
var when = require('when'), defer = when.defer;
var deferSync = require('./sync_defer').defer;
var assert = require('assert');
var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

function Channel(connection) {
  this.ch = connection.freshChannel(this); // %% move to open?
  this.connection = connection;
  // for the presently outstanding RPC
  this.reply = null;
  // for the RPCs awaiting action
  this.pending = [];
  this.handleMessage = acceptDeliveryOrReturn;
}
inherits(Channel, EventEmitter);

module.exports.Channel = Channel;

var C = Channel.prototype;

// Incoming frames are either notifications of e.g., message delivery,
// or replies to something we've sent. In general I deal with the
// former by emitting an event, and with the latter by keeping a track
// of what's expecting a reply.
//
// The AMQP specification implies that RPCs can't be pipelined; that
// is, you can have only one outstanding RPC on a channel at a
// time. Certainly that's what RabbitMQ and its clients assume. For
// this reason, I buffer RPCs if the channel is already waiting for a
// reply.


// Just send the damn frame.
C.sendImmediately = function(method, fields) {
  return this.connection.sendMethod(this.ch, method, fields);
};

// Invariant: !this.reply -> pending.length == 0. That is, whenever we
// clear a reply, we must send another RPC (and thereby fill
// this.reply) if there is one waiting. The invariant relevant here
// and in `accept`.
C.sendOrEnqueue = function(method, fields, reply) {
  if (!this.reply) { // if no reply waiting, we can go
    assert(this.pending.length === 0);
    this.reply = reply;
    this.sendImmediately(method, fields);
  }
  else {
    this.pending.push({method: method,
                       fields: fields,
                       reply: reply});
  }
};

C.sendMessage = function(fields, properties, content) {
  this.sendImmediately(defs.BasicPublish, fields);
  return this.connection.sendContent(this.ch,
                                     defs.BasicProperties, properties,
                                     content);
};

// Internal, synchronously resolved RPC
C._rpc = function(method, fields, expect) {
  var reply = deferSync();
  this.sendOrEnqueue(method, fields, reply);
  return reply.promise.then(function(f) {
    if (f.id === expect)
      return f;
    else
      throw new Error("Expected " + expect + " but got " + f);
  });
};

// An RPC that returns a 'proper' promise
C.rpc = function(method, fields, expect) {
  return when(this._rpc(method, fields, expect));
};

// Do the remarkably simple channel open handshake
C.open = function() {
  return this.rpc(defs.ChannelOpen, {outOfBand: ""},
                  defs.ChannelOpenOk);
};

// Shutdown protocol. There's three scenarios:
//
// 1. The application decides to shut the channel
// 2. The server decides to shut the channel, possibly because of
// something the application did
// 3. The connection is closing, so there won't be any more frames
// going back and forth.
//
// 1 and 2 involve an exchange of method frames (Close and CloseOk),
// while 3 doesn't; the connection simply says "shutdown" to the
// channel, which then acts as if it's closing, without going through
// the exchange.

// Move to entirely closed state. If err is provided, it was closed
// because there was an error; if not, it was all as intended.
C.toClosed = function(err) {
  this.sendImmediately = Channel.sendMessage = Channel.closedSend;
  this.sendOrEnqueue = Channel.closedEnqueue;
  this.accept = Channel.closedAccept;
  this.connection.releaseChannel(this.ch);
  if (err) this.emit('error', err);
  else this.emit('close');
};

Channel.closedSend = function() {
  throw new Error("Channel is closed, do not use");
};
Channel.closedAccept = function(f) {
  throw new Error("Channel is closed, not expecting frame: " + f);
};
Channel.closedEnqueue = function(_method, _fields, reply) {
  reply.reject(new Error("Channel is closed"));
};

// Stop being able to send and receive methods and content. Used when
// a channel close happens, and also by the connection when it closes.
C.stop = function() {
  // emit this now so apps have a chance to prepare for pending RPCs
  // to fail; but they can't respond by sending more.
  this.emit('end');

  function rej(r) { 
    r.reject(new Error("Channel ended, no reply will be forthcoming"));
  }
  if (this.reply) rej(this.reply);
  this.pending.forEach(rej);
  this.pending = null; // so pushes will break
};

// And the API for closing channels.
C.close = function() {
  return this.closeBecause("Goodbye", defs.constants.REPLY_SUCCESS);
};

C.closeBecause = function(reason, code) {
  this.sendImmediately(defs.ChannelClose, {
    replyText: reason,
    replyCode: code,
    methodId:0, classId: 0
  });
  
  var done = defer();
  var self = this;
  this.accept = function(f) {
    if (f.id === defs.ChannelCloseOk) {
      done.resolve();
      self.toClosed();
    }
    else if (f.id === defs.ChannelClose) {
      this.sendImmediately(defs.ChannelCloseOk, {});
    }
    else; // drop the frame
  };
  this.stop();
  return done.promise;
};

// A trampolining state machine for message frames on a channel. A
// message arrives in at least three frames: first, a method
// announcing the message (either a BasicDeliver or BasicGetOk); then,
// a message header with the message properties; then, one or more
// content frames. Message frames may be interleaved with method
// frames per channel, but they must not be interleaved with other
// message frames.

// Kick off a message delivery given a BasicDeliver or BasicReturn
// frame (BasicGet uses the RPC mechanism)
function acceptDeliveryOrReturn(f) {
  var event;
  if (f.id === defs.BasicDeliver) event = 'delivery';
  else if (f.id === defs.BasicReturn) event = 'return';
  else throw new Error("Unexpected BasicDeliver or BasicReturn, not " + f);

  var self = this;
  var fields = f.fields;
  return Channel.acceptMessage(function(message) {
    message.fields = fields;
    self.emit(event, message);
  });
}

// Move to the state of waiting for message frames (headers, then
// one or more content frames)
Channel.acceptMessage = function(continuation) {
  var remaining = 0;
  var buffers = null;

  var message = {
    fields: null,
    properties: null,
    content: null
  };

  return headers;

  // expect a headers frame
  function headers(f) {
    if (f.id === defs.BasicProperties) {
      message.properties = f.fields;
      remaining = f.size;
      return content;
    }
    else {
      throw new Error("Expected headers frame after delivery");
    }
  }

  // expect a content frame
  // %%% TODO cancelled messages (sent as zero-length content frame)
  function content(f) {
    if (f.content) {
      var size = f.content.length;
      remaining -= size;
      if (remaining === 0) {
        if (buffers !== null) {
          buffers.push(f.content);
          message.content = Buffer.concat(buffers);
        }
        else {
          message.content = f.content;
        }
        continuation(message);
        return acceptDeliveryOrReturn;
      }
      else if (remaining < 0) {
        throw new Error("Too much content sent!");
      }
      else {
        if (buffers !== null)
          buffers.push(f.content);
        else
          buffers = [f.content];
        return content;
      }
    }
    else throw new Error("Expected content frame after headers")
  }
}

C.accept = function(f) {

  switch (f.id) {

    // Message frames
  case undefined: // content frame!
  case defs.BasicDeliver:
  case defs.BasicReturn:
  case defs.BasicProperties:
    this.handleMessage = this.handleMessage(f);
    return;

    // confirmations, need to do confirm.select first
  case defs.BasicAck:
    return this.emit('ack', f);
  case defs.BasicNack:
    return this.emit('nack', f);

  case defs.ChannelClose:
    // Any remote closure is an error to us.
    var e = new Error("Channel closed: " + f.fields.replyText);
    this.stop();
    this.sendImmediately(defs.ChannelCloseOk, {});
    this.toClosed(e);
    return;

  case defs.BasicCancel:
    // The broker can send this if e.g., the queue is deleted.
    // TODO (also needs to send capability in client properties)
    throw new Error("Unexpected consumer cancel notification");
  case defs.BasicFlow:
    // RabbitMQ doesn't send this, it just blocks the TCP socket
    throw new Error("Not expecting a flow method");

  default: // assume all other things are replies
    // Resolving the reply may lead to another RPC; to make sure we
    // don't hold that up, clear this.reply
    var reply = this.reply; this.reply = null;
    // however, maybe there's an RPC waiting to go? If so, that'll
    // fill this.reply again, restoring the invariant. This does rely
    // on any response being recv'ed after resolving the promise,
    // below; hence, I use synchronous defer.
    if (this.pending.length > 0) {
      var send = this.pending.shift();
      this.reply = send.reply;
      this.sendImmediately(send.method, send.fields);
    }
    return reply.resolve(f);
  }
};
