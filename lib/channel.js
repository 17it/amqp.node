//
//
//

// Channel-centric model. This is like the RabbitMQ Java client, in
// which channels are general-purpose.

var defs = require('./defs');
var when = require('when'), defer = when.defer;
var deferSync = require('./sync_defer').defer;
var assert = require('assert');

function ChannelModel(connection) {
  if (!(this instanceof ChannelModel))
    return new ChannelModel(connection);
  this.connection = connection;
}

var CM = ChannelModel.prototype;

CM.createChannel = function() {
  var c;
  c = new Channel(this.connection,
                  this.connection.freshChannel(function(f) {
                    c.handle(f);
                  }));
  return c.rpc(defs.ChannelOpen, {outOfBand: ""},
               defs.ChannelOpenOk)
    .then(function(openok) {
      return c;
    });
};

module.exports = ChannelModel;

function Channel(connection, ch) {
  this.ch = ch;
  this.connection = connection;
  // for the presently outstanding RPC
  this.reply = null;
  // for the RPCs awaiting action
  this.pending = [];
  this.consumers = {};
  this.handleMessage = unexpectedFrame;
}

var C = Channel.prototype;


/*

There's three intermingled modes of interaction over a channel. The
first is simply to receive frames -- e.g., deliveries. The second is
to send a method, then at some later point, receive a reply. The AMQP
spec implies that RPCs can't be pipelined; that is, you can only have
one outstanding RPC per channel at a time. Certainly that's what
RabbitMQ and its clients assume. In these two modes, the way to
dispatch methods is

  1. If it's a reply method, look for the request in channel['reply']
  and hand it the method
  2. Otherwise, emit the method

The third mode is during the opening handshake, when there is a
specific sequence of methods involved. Presently this is implemented
in the connection rather than here, since it's not general-purpose.

*/

// Just send the damn frame.
C.sendImmediately = function(method, fields) {
  return this.connection.sendMethod(this.ch, method, fields);
};

// Invariant: !this.reply -> pending.length == 0. That is, whenever we
// clear a reply, we must send another RPC (and thereby fill
// this.reply) if there is one waiting.

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
    if (f.id === expect) {
      return f;
    }
    else throw new Error("Expected " + expect + " but got " + f);
  });
};

// An RPC that returns a 'proper' promise
C.rpc = function(method, fields, expect) {
  return when(this._rpc(method, fields, expect));
};

// Not sure I like the ff, it's going to be changing hidden classes
// all over the place. On the other hand, whaddya do.
C.registerConsumer = function(tag, callback) {
  this.consumers[tag] = callback;
};

C.unregisterConsumer = function(tag) {
  delete this.consumers[tag];
};


// %%% Revisit

function unexpectedFrame(f) {
  throw new Error("Unannounced message frame: " + f)
}

function acceptDelivery(f) {
  var self = this;
  var fields = f.fields;
  var consumerTag = fields.consumerTag;
  return acceptMessage(function(message) {
    message.fields = fields;
    self.dispatchMessage(consumerTag, message);
  });
}

function acceptMessage(continuation) {
  var remaining = 0;
  var buffers = null;

  var message = {
    fields: null,
    properties: null,
    content: null
  };

  return headers;

  // ---states
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
        return unexpectedFrame;
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

C.dispatchMessage = function(consumerTag, message) {
  var consumer = this.consumers[consumerTag];
  if (consumer) {
    return consumer(message);
  }
  else {
    // %%% Surely a race here
    throw new Error("Unknown consumer: " + message.consumerTag);
  }
};

C.handle = function(f) {

  var self = this;

  switch (f.id) {
    // Consumery things
  case defs.BasicDeliver:
    this.handleMessage = acceptDelivery; // prime for invoking handler just below
  case undefined: // content frame!
  case defs.BasicProperties:
    this.handleMessage = this.handleMessage(f);
    return;

  case defs.BasicAck:
  case defs.BasicNack: // confirmations, need to do confirm.select first
    throw new Error("Confirmations not implemented");

  case defs.ChannelClose:
    if (this.reply) {
      // %%% Can I do anything with the classId & methodId?
      var e = new Error("Channel closed: " + f.replyText);
      this.reply.reject(e);
    }
    this.sendImmediately(defs.ChannelCloseOk, {});
    // %%% ORLY?
    this.pending.forEach(function(s) { s.reply.reject(e); });
    return this.cleanup();

  case defs.BasicCancel:
    // The broker can send this if e.g., the queue is deleted.
    // TODO (also needs to send capability in client properties)
    throw new Error("Unexpected consumer cancel notification");
  case defs.BasicReturn:
    throw new Error("I don't handle returns yet");

  default: // assume all other things are replies
    // Resolving the reply may lead to another RPC; to make sure we
    // don't hold that up, clear this.reply
    var reply = this.reply; this.reply = null;
    // however, maybe there's an RPC waiting to go? If so, that'll
    // fill this.reply again, restoring the invariant. This does rely
    // on any response being recv'ed after resolving the promise,
    // below; for that reason, synchronous deferreds are used.
    if (this.pending.length > 0) {
      var send = this.pending.shift();
      this.reply = send.reply;
      this.sendImmediately(send.method, send.fields);
    }
    return reply.resolve(f);
  }
};

// === Public API, declaring queues and stuff ===

/*
Assert a queue into existence. This will bork the channel if the queue
already exists but has different properties; values supplied in the
`arguments` table may or may not count for borking purposes (check the
broker's documentation). If you supply an empty string as `queue`, or
don't supply it at all, the server will create a random name for you.

`options` is an object and may also be omitted. The options are:

- `exclusive`: if true, scopes the queue to the connection (defaults
  to false)

- `durable`: if true, the queue will survive broker restarts, modulo
  the effects of `exclusive` and `autoDelete`; this defaults to true
  if not supplied, unlike the others

- `autoDelete`: if true, the queue will be deleted when the number of
  consumers drops to zero (defaults to false)

- `arguments`: additional arguments, usually parameters for some kind
  of broker-specific extension e.g., high availability, TTL.

RabbitMQ extensions can also be supplied as options. These typically
require non-standard `x-*` keys and values sent in the `arguments`
table; e.g., `x-expires`. Here, I've removed the `x-` prefix and made
them options; they will overwrite anything you supply in `arguments`.

- `messageTtl` (0 <= n < 2^32): expires messages arriving in the queue
  after n milliseconds

- `expires` (0 < n < 2^32): the queue will be destroyed after n
  milliseconds of disuse, where use means having consumers, being
  declared (or checked, in this API), or being polled with a `get`.

- `deadLetterExchange` (string): an exchange to which messages
  discarded from the queue will be resent. Use `deadlLetterRoutingKey`
  to set a routing key for discarded messages; otherwise, the
  message's routing key (and CC and BCC, if present) will be
  preserved. A message is discarded when it expires or is rejected, or
  the queue limit is reached.

- `maxLength` (positive integer): sets a maximum number of messages
  the queue will hold. Old messages will be discarded (dead-lettered
  if that's set) to make way for new messages.
*/
C.assertQueue = function(queue, options) {
  queue = queue || '';
  options = options || {};
  var args;
  if (options.expires ||
      options.deadLetterExchange ||
      options.deadLetterRoutingKey ||
      options.maxLength) {
    args = options.arguments || {};
    args.expires = options.expires;
    args.deadLetterExchange = options.deadLetterExchange;
    args.deadLetterRoutingKey = options.deadLetterRoutingKey;
    args.maxLength = options.maxLength;
  }
  
  var fields = {
    queue: queue,
    exclusive: !!options.exclusive,
    durable: (options.durable === undefined) ? true : options.durable,
    autoDelete: !!options.autoDelete,
    arguments: args,
    passive: false,
    // deprecated but we have to include it
    ticket: 0,
    nowait: false
  };
  return this.rpc(defs.QueueDeclare, fields, defs.QueueDeclareOk);
};

// Check whether a queue exists. This will bork the channel if the
// named queue *doesn't* exist; if it does exist, hooray! There's no
// options as with `declareQueue`, just the queue name. The success
// value of the returned promise has the queue name, message count,
// and number of consumers. Should you care.
C.checkQueue = function(queue) {
  var fields = {
    queue: queue,
    passive: true, // switch to "completely different" mode
    nowait: false,
    durable: true, autoDelete: false, exclusive: false, // ignored
    ticket: 0,
  };
  return this.rpc(defs.QueueDeclare, fields, defs.QueueDeclareOk);
};

/*
Assert an exchange into existence. As with queues, if the exchange
exists already and has properties different to those supplied, the
channel will splode; fields in the arguments table may or may not be
splodey. Unlike queues, you must supply a name, and it can't be the
empty string. You must also supply an exchange type, which determines
how messages will be routed through the exchange.

*NB* There is just one RabbitMQ extension pertaining to exchanges in
general; however, specific exchange types may use the `arguments`
table to supply parameters.

The options:

- `durable` (boolean): if true, the exchange will survive broker
  restarts. Defaults to true.

- `internal` (boolean): if true, messages may not be published
  directly to the exchange (i.e., it can only be the target of
  bindings, or possibly create messages ex-nihilo). Defaults to false.

- `autoDelete` (boolean): if true, the exchange will be destroyed once
  the number of bindings for which it is the source drop to
  zero. Defaults to false.

- `alternateExchange` (string): an exchange to send messages to if
  this exchange can't route them to any queues.

*/
C.assertExchange = function(exchange, type, options) {
  options = options || {};
  var args;
  if (options.alternateExchange) {
    args = options.arguments || {};
    args.alternateExchange = options.alternateExchange;
  }
  var fields = {
    exchange: exchange,
    ticket: 0,
    type: type,
    passive: false,
    durable: (options.durable === undefined) ? true : options.durable,
    autoDelete: !!options.autoDelete,
    internal: !!options.internal,
    nowait: false,
    arguments: args
  };
  return this.rpc(defs.ExchangeDeclare, fields, defs.ExchangeDeclareOk);
};

C.checkExchange = function(exchange) {
  var fields = {
    exchange: exchange,
    passive: true, // switch to 'may as well be another method' mode
    nowait: false,
    // ff are ignored
    durable: true, internal: false,  type: '',  autoDelete: false,
    ticket: 0
  };
  return this.rpc(defs.ExchangeDeclare, fields, defs.ExchangeDeclareOk);
};

/*
Publish a single message on the connection. The mandatory parameters
(these go in the publish method itself) are:

 - `exchange` and `routingKey`: the exchange and routing key, which
 determine where the message goes. A special case is sending `''` as
 the exchange, which will send directly to the queue named by the
 routing key.

The remaining parameters are optional, and are divided into those that
have some meaning to RabbitMQ and those that will be ignored by
RabbitMQ.

The former options are a mix of fields in BasicDeliver (the method
used to publish a message), BasicProperties (in the message header
frame) and RabbitMQ extensions which are given in the `headers` table
in BasicProperties.

Used by RabbitMQ and sent on to consumers:

 - `expiration` (string): if supplied, the message will be discarded
   from a queue once it's been there longer than the given number of
   milliseconds. In the specification this is a string; numbers
   supplied here will be coerced.

 - `userId` (string): If supplied, RabbitMQ will compare it to the
   username supplied when opening the connection, and reject messages
   for which it does not match.

 - `CC` (array of string): an array of routing keys as strings;
   messages will be routed to these routing keys in addition to that
   given as the `routingKey` parameter. This will override any value
   given for `CC` in the `headers` parameter. *NB* The property names
   `CC` and `BCC` are case-sensitive.

Used by RabbitMQ but not sent on to consumers:

 - `mandatory` (boolean): if true, the message will be returned if it
   is not routed to a queue (i.e., if there are no bindings that match
   its routing key).

 - `deliveryMode` (boolean): if true, the message will survive a
   broker restart. Default is false. (In the specification this is
   either `1` meaning non-persistent, or `2` meaning
   persistent. That's just silly though)

 - `BCC` (array of string): like `CC`, except that the value will not
   be sent in the message headers to consumers.

Ignored by RabbitMQ and not sent to consumers:

 - `immediate` (boolean): return the message if it is not able to be sent
   immediately to a consumer. No longer implemented in RabbitMQ

Ignored by RabbitMQ (but may be useful for applications):

 - `contentType` (string): a MIME type for the message content

 - `contentEncoding` (string): a MIME encoding for the message content

 - `headers` (object): application specific headers to be carried
   along with the message content. The value as sent may be augmented
   by extension-specific fields if they are given in the parameters,
   for example, 'cc', since these are encoded as message headers; the
   supplied value won't be mutated.

 - `priority` (0..9): a notional priority for the message; presently
   ignored by RabbitMQ

 - `correlationId` (string): usually used to match replies to
   requests, or similar.

 - `replyTo` (string): often used to name a queue to which the
   receiving application must send replies, in an RPC scenario (many
   libraries assume this pattern)

 - `messageId` (string): arbitrary application-specific identifier for
   the message

 - `timestamp` (positive number): a timestamp for the message

 - `type` (string): an arbitrary application-specific type for the
   message

 - `appId` (string): an arbitrary identifier for the originating
   application

*/
C.publish = function(params, content) {
  // The CC and BCC fields expect an array of "longstr", which would
  // normally be buffer values in JavaScript; however, since a field
  // array (or table) cannot have shortstr values, the codec will
  // encode all strings as longstrs anyway.
  function convertCC(cc) {
    if (cc === undefined) {
      return undefined;
    }
    else if (Array.isArray(cc)) {
      return cc.map(String);
    }
    else return [String(cc)];
  }

  var fields = {
    exchange: params.exchange,
    routingKey: params.routingKey,
    mandatory: !!params.mandatory,
    immediate: false,
    ticket: 0
  };
  var headers;
  if (params.CC || params.BCC) {
    headers = {};
    for (var k in params.headers) headers[k] = params.headers[k];
    headers.CC = convertCC(params.CC);
    headers.BCC = convertCC(params.BCC);
  }
  else headers = params.headers;
  var deliveryMode; // undefined will default to 1 (non-persistent)
  if (params.deliveryMode) deliveryMode = 2;
  var expiration = params.expiration;
  if (expiration !== undefined) expiration = expiration.toString();

  var properties = {
    contentType: params.contentType,
    contentEncoding: params.contentEncoding,
    headers: headers,
    deliveryMode: deliveryMode,
    priority: params.priority,
    correlationId: params.correlationId,
    replyTo: params.replyTo,
    expiration: expiration,
    messageId: params.messageId,
    timestamp: params.timestamp,
    type: params.type,
    userId: params.userId,
    appId: params.appId,
    clusterId: ''
  };
  return this.sendMessage(fields, properties, content);
};

/*
Set up a consumer with a callback.

Options (which may be omitted altogether):

- `consumerTag` (string): a name which the server will use to
  distinguish message deliveries for the consumer; mustn't be already
  in use on the channel. It's usually easier to omit this, in which
  case the server will create a random name.

- `noLocal` (boolean): in theory, if true then the broker won't
  deliver messages to the consumer if they were also published on this
  connection; RabbitMQ doesn't implement it though. Defaults to false.

- `noAck` (boolean): if true, the broker won't expect an
  acknowledgement of messages delivered to this consumer; i.e., it
  will dequeue messages as soon as they've been sent down the
  wire. Defaults to false (i.e., you will acknowledge messages).

- `exclusive` (boolean): if true, the broker won't let anyone else
  consume from this queue; if there already is a consumer, there goes
  your channel (so usually only useful if you've made a 'private'
  queue by letting the server choose its name).

- `arguments` (object): arbitrary arguments. No RabbitMQ extensions
  use these, but hey go to town.

*/
C.consume = function(queue, callback, options) {
  options = options || {};
  var fields = {
    ticket: 0,
    queue: queue,
    consumerTag: options.consumerTag || '',
    noLocal: !!options.noLocal,
    noAck: !!options.noAck,
    exclusive: !!options.exclusive,
    nowait: false,
    arguments: options.arguments
  };
  var self = this;
  // NB we want the callback to be run synchronously, so that we've
  // registered the consumerTag before any messages can arrive.
  return when(
    this._rpc(defs.BasicConsume, fields, defs.BasicConsumeOk)
      .then(function(consumeOk) {
        self.registerConsumer(consumeOk.fields.consumerTag, callback);
        return consumeOk;
      }));
};

/*
Ask a queue for a message. This returns a promise that will be
resolved with either false, if there is no message to be had, or a
message.

Options:

 - noAck (boolean): if true, the message will be assumed by the server
   to be acknowledged (i.e., dequeued) as soon as it's been sent over
   the wire. Default is false.
*/
C.get = function(queue, options) {
  var reply = deferSync();
  var self = this;

  var fields = {
    ticket: 0,
    queue: queue,
    noAck: !!options.noAck
  };

  this.sendOrEnqueue(defs.BasicGet, fields, reply);
  return when(reply.promise.then(function(f) {
    if (f.id === defs.BasicGetEmpty) {
      return false;
    }
    else if (f.id === defs.BasicGetOk) {
      var delivery = deferSync();
      var fields = f.fields;
      self.handleMessage = acceptMessage(function(m) {
        m.fields = fields;
        delivery.resolve(m);
      });
      return delivery.promise;
    }
    else {
      throw new Error("Unexpected response to BasicGet: " + f);
    }
  }));
};
