---
layout: default
title: Channel API reference
---

# Channel-oriented API reference

This is the "main" module in the library:

```javascript
var amqp = require('amqplib');
```

The client API is based closely on the protocol model. The _modus
operandi_ is to create channels on which to issue commands. Most
errors in AMQP invalidate just the channel which had problems, so this
ends up being a fairly natural way to use AMQP. The downside is that
it doesn't give any guidance on *useful* ways to use AMQP; that is, it
does little beyond giving access to the various AMQP methods.

Most operations in AMQP are RPCs, synchronous at the channel layer of
the protocol but asynchronous from the library's point of view;
accordingly, most methods return promises yielding the server's reply
(often containing useful information such as generated
identifiers). RPCs are queued by the channel if it is already waiting
for a reply.

Failed operations will

 * reject the current RPC, if there is one
 * invalidate the channel object
 * reject any RPCs waiting to be sent
 * cause the channel object to emit `'error'`

Promises returned from methods are amenable to composition using, for
example, when.js's functions:

```javascript
amqp.connect().then(function(conn) {
  var ok = conn.createChannel();
  ok = ok.then(function(ch) {
    return when.all([
      ch.assertQueue('foo'),
      ch.assertExchange('bar'),
      ch.bindQueue('foo', 'bar', 'baz'),
      ch.consume('foo', handleMessage)
    ]);
  });
  return ok;
}).then(null, console.warn);
```

(The dependence of the later operations above on prior operations is
OK, by the way, because RPCs are synchronous per channel. Any failures
will invalidate the channel, so subsequent operations will also
fail.)

Many operations have mandatory arguments as well as optional arguments
with defaults; in general, the former appear as parameters to the
method while latter are collected in a single `options` parameter, to
be supplied as an object with the fields mentioned. Extraneous fields
in `options` are ignored, so it is often possible to coalesce the
options for a number of operations into a single object, should that
be convenient.

## `connect([url], [socketOptions])`

Connect to an AMQP 0-9-1 server, optionally given an AMQP URL (see
[AMQP URI syntax][amqpurl]) and socket options. The protocol part
(`amqp:` or `amqps:`) is mandatory; defaults for elided parts are as
given in `'amqp://guest:guest@localhost:5672'`. If the URL is omitted
entirely, it will default to `'amqp://localhost'`, which given the
defaults for missing parts, will connect to a RabbitMQ installation
with factory settings, on localhost.

For convenience, an _absent_ path segment (e.g., as in the URLs just
given) is interpreted as the virtual host named `/`, which is present
in RabbitMQ out of the box. Per the URI specification, _just a
trailing slash_ as in `'amqp://localhost/'` would indicate the virtual
host with an empty name, which does not exist unless it's been
explicitly created. When specifying another virtual host, remember
that its name must be escaped; so e.g., the virtual host named `/foo`
is `'%2Ffoo'`; in a full URI, `'amqp://localhost/%2Ffoo'`.

Further AMQP tuning parameters may be given in the query part of the
URL, e.g., as in `'amqp://localhost?frameMax=0x1000'`. These are:

 * `frameMax`, the size in bytes of the maximum frame allowed over the
   connection. `0` means no limit (but since frames have a size field
   which is an unsigned 32 bit integer, it's perforce `2^32 - 1`); I
   default it to 0x1000, i.e. 4kb, which is the allowed minimum, will
   fit many purposes, and not chug through Node.JS's buffer pooling.

 * `channelMax`, the maximum number of channels allowed. Default is
   `0`, meaning `2^16 - 1`.

 * `heartbeat`: the period of the connection heartbeat, in
   seconds. Defaults to `0`, meaning no heartbeat. OMG no heartbeat!
   (**NB** heartbeating isn't implemented yet, so best to let it
   default)

 * `locale`: the desired locale for error messages, I
   suppose. RabbitMQ only ever uses `en_US`; which, happily, is the
   default.

The socket options will be passed to the socket library (`net` or
`tls`). They must be fields set on the object supplied; i.e., not on a
prototype. This is useful for supplying certificates and so on for an
SSL connection; see the [SSL guide][ssl-doc].

Returns a promise which will either be resolved with an open
`ChannelModel` or rejected with a sympathetically-worded error (in
en_US).

## `ChannelModel(connection)`

This constructor represents a connection in the channel API. It takes
as an argument a `connection.Connection`; though it is better to use
`connect()`, which will open the connection for you. It is exported as
a potential extension point.

### `ChannelModel#close`

Close the connection cleanly. Will immediately invalidate any
unresolved operations, so it's best to make sure you've done
everything you need to before calling this. Returns a promise which
resolves once the connection, and underlying socket, are closed. The
`ChannelModel` will also emit `'close'` at that point.

Although it's not strictly necessary, it will avoid some warnings in
the server log if you close the connection before exiting:

```javascript
var open = amqp.connect();
open.then(function(conn) {
  var ok = doStuffWithConnection(conn);
  return ok.then(conn.close.bind(conn));
}).then(null, console.warn);
```

Note that I'm synchronising on the return value of
`doStuffWithConnection()`, presumably a promise, so that I can be sure
I'm all done.

If your program runs until interrupted, you can hook into the process
signal to close the connection:

```javascript
var open = amqp.connect();
open.then(function(conn) {
  process.on('SIGINT', conn.close.bind(conn));
  return doStuffWithConnection(conn);
}).then(null, console.warn);
```

**NB** it's no good using `process.on('exit', ...)`, since `close()` needs
to do I/O.

### `ChannelModel#on('close', callback)`

Emitted once the closing handshake initiated by `#close()` has
completed. Only one of `'close`' or `'error'` will ever be emitted by
a connection; either indicates that the connection is defunct.

### `ChannelModel#on('error', callback)`

Emitted if the server closes the connection for any reason; such
reasons include:

 * a protocol transgression the server detected (likely a bug in this
   library)
 * a server error
 * a human closed the connection with an admin tool

### `ChannelModel#createChannel()`

Open a fresh channel. Returns a promise of an open `Channel`. May fail
if there are no more channels available (i.e., if there are already
`channelMax` channels open).

## `Channel`

This constructor represents a protocol channel. Channels are
multiplexed over connections, and represent something like a session,
in that most operations (and thereby most errors) are scoped to
channels.

The constructor is exported from the module as an extension
point. When using the client library in an application, obtain an open
`Channel` by opening a connection (`connect()` above) and calling
`#createChannel`.

### `Channel#close()`

Close a channel. Returns a promise which will be resolved once the
closing handshake is complete. Any unresolved operations on the
channel will be abandoned (and the returned promises rejected).

There's not usually any reason to close a channel rather than
continuing to use it until you're ready to close the connection
altogether. However, the lifetimes of consumers are scoped to
channels, and thereby other things such as exclusive locks on queues,
so it is occasionally worth being deliberate about opening and closing
channels.

### `Channel#on('close', callback)`

A channel will emit `'close'` once the closing handshake initiated by
`#close()` has completed. Only one of `'close'` or `'error'` will ever
be emitted by a channel.

Closing a connection implicitly closes all the channels it is
multiplexing; in this case the channels will each emit `'close'`.

### `Channel#on('error', callback)`

A channel will emit `'error'` if the server closes the channel for any
reason. Such reasons include

 * an operation failed due to a failed precondition (usually
  something named in an argument not existing)
 * an human closed the channel with an admin tool

### `Channel#assertQueue([queue], [options])`

Assert a queue into existence. This operation is idempotent given
identical arguments; however, it will bork the channel if the queue
already exists but has different properties (values supplied in the
`arguments` field may or may not count for borking purposes; check the
broker's documentation).

`queue` is a string; if you supply an empty string or other falsey
value, the server will create a random name for you.

`options` is an object and may also be omitted. The relevant fields in
options are:

 * `exclusive`: if true, scopes the queue to the connection (defaults
  to false)

 * `durable`: if true, the queue will survive broker restarts, modulo
  the effects of `exclusive` and `autoDelete`; this defaults to true
  if not supplied, unlike the others

 * `autoDelete`: if true, the queue will be deleted when the number of
  consumers drops to zero (defaults to false)

 * `arguments`: additional arguments, usually parameters for some kind
  of broker-specific extension e.g., high availability, TTL.

RabbitMQ extensions can also be supplied as options. These typically
require non-standard `x-*` keys and values sent in the `arguments`
table; e.g., `x-expires`. Here, I've removed the `x-` prefix and made
them options; they will overwrite anything you supply in `arguments`.

 * `messageTtl` (0 <= n < 2^32): expires messages arriving in the
  queue after n milliseconds

 * `expires` (0 < n < 2^32): the queue will be destroyed after n
  milliseconds of disuse, where use means having consumers, being
  declared (asserted or checked, in this API), or being polled with a
  `#get`.

 * `deadLetterExchange` (string): an exchange to which messages
  discarded from the queue will be resent. Use `deadLetterRoutingKey`
  to set a routing key for discarded messages; otherwise, the
  message's routing key (and CC and BCC, if present) will be
  preserved. A message is discarded when it expires or is rejected, or
  the queue limit is reached.

 * `maxLength` (positive integer): sets a maximum number of messages
  the queue will hold. Old messages will be discarded (dead-lettered
  if that's set) to make way for new messages.

Returns a promise of the "ok" reply from the server, which includes
fields for the queue name (important if you let the server name it), a
recent consumer count, and a recent message count; e.g.,

```javascript
{
  queue: 'foobar',
  messageCount: 0,
  consumerCount: 0
}
```

### `Channel#checkQueue(queue)`

Check whether a queue exists. This will bork the channel if the named
queue *doesn't* exist; if it does exist, you go through to the next
round!  There's no options as with `#assertQueue()`, just the queue
name. The reply from the server is the same as for `#assertQueue()`.

### `Channel#deleteQueue(queue)`

Delete the queue named. Naming a queue that doesn't exist will result
in the server closing the channel, to teach you a lesson. The options
here are:

 * `ifUnused` (boolean): if true and the queue has consumers, it will
   not be deleted and the channel will be closed. Defaults to false.

 * `ifEmpty` (boolean): if true and the queue contains messages, the
   queue will not be deleted and the channel will be closed. Defaults
   to false.

Note the obverse semantics of the options: if both are true, the queue
will be deleted only if it has no consumers *and* no messages.

You should leave out the options altogether if you want to delete the
queue unconditionally.

The server reply contains a single field, `messageCount`, with the
number of messages deleted along with the queue.

### `Channel#purgeQueue(queue)`

Remove all undelivered messages from the `queue` named. Note that this
won't remove messages that have been delivered but not yet
acknowledged; they will remain, and may be requeued under some
circumstances (e.g., if the channel to which they were delivered
closes without acknowledging them).

The server reply contains a single field, `messageCount`, containing
the number of messages purged from the queue.

### `Channel#bindQueue(queue, source, pattern, [args])`

Assert a routing path from an exchange to a queue: the exchange named
by `source` will relay messages to the `queue` named, according to the
type of the exchange and the `pattern` given. The [RabbitMQ
tutorials][rabbitmq-tutes] give a good account of how routing works in
AMQP.

`args` is an object containing extra arguments that may be required
for the particular exchange type (for which, see [your server's
documentation][rabbitmq-docs]). It may be omitted if not needed, which
is equivalent to an empty object.

The server reply has no fields.

### `Channel#unbindQueue(queue, source, pattern, [args])`

Remove a routing path between the `queue` named and the exchange named
as `source` with the `pattern` and arguments given. Omitting `args` is
equivalent to supplying an empty object (no arguments). Beware:
attempting to unbind when there is no such binding may result in a
punitive error (the AMQP specification says it's a connection-killing
mistake; RabbitMQ softens this to a channel error. Good ol' RabbitMQ).

### `Channel#assertExchange(exchange, type, [options])`

Assert an exchange into existence. As with queues, if the exchange
exists already and has properties different to those supplied, the
channel will 'splode; fields in the arguments object may or may not be
'splodey, depending on the type of exchange. Unlike queues, you must
supply a name, and it can't be the empty string. You must also supply
an exchange type, which determines how messages will be routed through
the exchange.

**NB** There is just one RabbitMQ extension pertaining to exchanges in
general (`alternateExchange`); however, specific exchange types may
use the `arguments` table to supply parameters.

The options:

 * `durable` (boolean): if true, the exchange will survive broker
  restarts. Defaults to true.

 * `internal` (boolean): if true, messages cannot be published
  directly to the exchange (i.e., it can only be the target of
  bindings, or possibly create messages ex-nihilo). Defaults to false.

 * `autoDelete` (boolean): if true, the exchange will be destroyed
  once the number of bindings for which it is the source drop to
  zero. Defaults to false.

 * `alternateExchange` (string): an exchange to send messages to if
  this exchange can't route them to any queues.

The server reply echoes the exchange name, in the field `exchange`.

### `Channel#checkExchange(exchange)`

Check that an exchange exists. If it doesn't exist, the channel will
be closed with an error. If it does exist, happy days.

### `Channel#deleteExchange(name, [options])`

Delete an exchange. The only meaningful field in `options` is:

 * ifUnused (boolean): if true and the exchange has bindings, it will
  not be deleted and the channel will be closed.

The server reply has no fields.

### `Channel#bindExchange(destination, source, pattern, [args])`

Bind an exchange to another exchange. The exchange named by
`destination` will receive messages from the exchange named by
`source`, according to the type of the source and the `pattern`
given. For example, a `direct` exchange will relay messages that have
a routing key equal to the pattern.

**NB** Exchange to exchange bindings is a RabbitMQ extension.

The server reply has no fields.

### `Channel#unbindExchange(destination, source, pattern, [args])`

Remove a binding from an exchange to a queue. A binding with the exact
`source` exchange, destination `queue`, routing key `pattern`, and
extension `args` will be removed. If no such binding exists, it's &ndash;
you guessed it &ndash; a channel error.

### `Channel#publish(exchange, routingKey, content, [options])`

Publish a single message to an exchange. The mandatory parameters
(these go in the publish method itself) are:

 * `exchange` and `routingKey`: the exchange and routing key, which
 determine where the message goes. A special case is sending `''` as
 the exchange, which will send directly to the queue named by the
 routing key; `#sendToQueue` below is equivalent to this special case.

 * `content`: a buffer containing the message content. This will be
 copied during encoding, so it is safe to mutate it once this method
 has returned.

The remaining parameters are provided as fields in `options`, and are
divided into those that have some meaning to RabbitMQ and those that
will be ignored by RabbitMQ. `options` may be omitted altogether, in
which case defaults as noted will apply.

The "meaningful" options are a mix of fields in BasicDeliver (the
method used to publish a message), BasicProperties (in the message
header frame) and RabbitMQ extensions which are given in the `headers`
table in BasicProperties.

Used by RabbitMQ and sent on to consumers:

 * `expiration` (string): if supplied, the message will be discarded
   from a queue once it's been there longer than the given number of
   milliseconds. In the specification this is a string; numbers
   supplied here will be coerced to strings for transit.

 * `userId` (string): If supplied, RabbitMQ will compare it to the
   username supplied when opening the connection, and reject messages
   for which it does not match.

 * `CC` (string or array of string): an array of routing keys as
   strings; messages will be routed to these routing keys in addition
   to that given as the `routingKey` parameter. A string will be
   implicitly treated as an array containing just that string. This
   will override any value given for `CC` in the `headers`
   parameter. **NB** The property names `CC` and `BCC` are
   case-sensitive.

Used by RabbitMQ but not sent on to consumers:

 * `mandatory` (boolean): if true, the message will be returned if it
   is not routed to a queue (i.e., if there are no bindings that match
   its routing key).

 * `deliveryMode` (boolean): if true, the message will survive a
   broker restart, provided it's in a durable queue. Default is
   false. (In the specification this is either `1` meaning
   non-persistent, or `2` meaning persistent. That's just obscure
   though)

 * `BCC` (string or array of string): like `CC`, except that the value
   will not be sent in the message headers to consumers.

Not used by RabbitMQ and not sent to consumers:

 * `immediate` (boolean): in the specification, this instructs the
   server to return the message if it is not able to be sent
   immediately to a consumer. No longer implemented in RabbitMQ, and
   if true, will provoke a channel error, so it's best to leave it
   out.

Ignored by RabbitMQ (but may be useful for applications):

 * `contentType` (string): a MIME type for the message content

 * `contentEncoding` (string): a MIME encoding for the message content

 * `headers` (object): application specific headers to be carried
   along with the message content. The value as sent may be augmented
   by extension-specific fields if they are given in the parameters,
   for example, 'CC', since these are encoded as message headers; the
   supplied value won't be mutated.

 * `priority` (0..9): a notional priority for the message; presently
   ignored by RabbitMQ

 * `correlationId` (string): usually used to match replies to
   requests, or similar.

 * `replyTo` (string): often used to name a queue to which the
   receiving application must send replies, in an RPC scenario (many
   libraries assume this pattern)

 * `messageId` (string): arbitrary application-specific identifier for
   the message

 * `timestamp` (positive number): a timestamp for the message

 * `type` (string): an arbitrary application-specific type for the
   message

 * `appId` (string): an arbitrary identifier for the originating
   application

### `Channel#sendToQueue(queue, content, [options])`

Send a single message with the `content` given as a buffer to the
specific `queue` named, bypassing routing. The options are exactly the
same as for `#publish`.

### `Channel#consume(queue, callback, [options])`

Set up a consumer with a callback to be invoked with each message.

Options (which may be omitted altogether):

 * `consumerTag` (string): a name which the server will use to
  distinguish message deliveries for the consumer; mustn't be already
  in use on the channel. It's usually easier to omit this, in which
  case the server will create a random name and supply it in its
  reply.

 * `noLocal` (boolean): in theory, if true then the broker won't
  deliver messages to the consumer if they were also published on this
  connection; RabbitMQ doesn't implement it though. Defaults to false.

 * `noAck` (boolean): if true, the broker won't expect an
  acknowledgement of messages delivered to this consumer; i.e., it
  will dequeue messages as soon as they've been sent down the
  wire. Defaults to false (i.e., you will be expected to acknowledge
  messages).

 * `exclusive` (boolean): if true, the broker won't let anyone else
  consume from this queue; if there already is a consumer, there goes
  your channel (so usually only useful if you've made a 'private'
  queue by letting the server choose its name).

 * `arguments` (object): arbitrary arguments. No RabbitMQ extensions
  use these, but hey go to town.

The server reply contains one field, `consumerTag`. It is necessary to
remember this somewhere if you will later want to cancel this consume
operation (i.e., to stop getting messages).

The callback supplied will be invoked with message objects of this
shape:

```javascript
{
  content: Buffer,
  fields: Object,
  properties: Object
}
```

The message `content` is a buffer containing the bytes published.

The fields object has a handful of bookkeeping values largely of
interest only to the library code: `deliveryTag`, a serial number for
th message; `consumerTag`, identifying the consumer for which the
message is destined; `exchange` and `routingKey` giving the routing
information with which the message was published; and, `redelivered`,
which if true indicates that this message has been delivered before
and been handed back to the server (e.g., by a nack or recovery
operation).

The `properties` object contains message properties, which are all the
things mentioned under `#publish` as options that are
transmitted. Note that RabbitMQ extensions (just `CC`, presently) are
sent in the `headers` table so will appear there in deliveries.

### `Channel#cancel(consumerTag)`

This instructs the server to stop sending messages to the consumer
identified by `consumerTag`. Messages may arrive between sending this
and getting its reply; once the reply has resolved, however, there
will be no more messages for the consumer, i.e., the callback will not
be invoked.

The `consumerTag` is the string given in the reply to `#consume`,
which may have been generated by the server.

### `Channel#get(queue, [options])`

Ask a queue for a message, as an RPC. This returns a promise that will
be resolved with either false, if there is no message to be had, or a
message (in the same shape as detailed in `#consume`).

Options:

 * noAck (boolean): if true, the message will be assumed by the server
   to be acknowledged (i.e., dequeued) as soon as it's been sent over
   the wire. Default is false, that is, you will be expected to
   acknowledge messages.

### `Channel#ack(message, [allUpTo])`

Acknowledge the given message, or all messages up to and including the
given message.

If a `#consume` or `#get` is issued with noAck: false (the default),
the server will expect acknowledgements for messages before forgetting
about them. If no such acknowledgement is given, those messages may be
requeued once the channel is closed.

If `allUpTo` is true, all outstanding messages prior to and including
the given message shall be considered acknowledged. If false, or
omitted, only the message supplied is acknowledged.

It's an error to supply a message that either doesn't require
acknowledgement, or has already been acknowledged. Doing so will
errorise the channel. If you want to acknowledge all the messages and
you don't have a specific message around, use `#ackAll`.

### `Channel#ackAll()`

Acknowledge all outstanding messages on the channel. This is a "safe"
operation, in that it won't result in an error even if there are no
such messages.

### `Channel#nack(message, [allUpTo], [requeue])`

Reject a message. This instructs the server to either requeue the
message or throw it away (which may mean dead-lettering it).

If 'allUpTo' is true, all outstanding messages prior to and including
the given message are rejected. As with `ack`, it's a channel-ganking
error to use a message that is not outstanding. Defaults to false.

If `requeue` is true, the server will try to put the message or
messages back on the queue or queues from which they came. Defaults to
true if not given, so if you want to make sure messages are
dead-lettered or discarded, supply false here.

### `Channel#nackAll([requeue])`

Reject all messages outstanding on this channel. If `requeue` is true,
or omitted, the server will try to re-enqueue the messages.

### `Channel#prefetch(count)`

Set the prefetch count for this channel. The `count` given is the
maximum number of messages sent over the channel that can be awaiting
acknowledgement; once there are `count` messages outstanding, the
server will not send more messages on this channel until one or more
have been acknowledged. A falsey value for `count` indicates no such
limit.

### `Channel#recover()`

Requeue unacknowledged messages on this channel. The returned promise
will be resolved (with an empty object) once all messages are
requeued.

## `ChannelModel#createConfirmChannel()`

Create a channel which uses confirmations (a [RabbitMQ
extension][rabbitmq-confirms]). As with `#createChannel`, the return
value is a promise that will be resolved with an open channel.

On the resulting channel, each published message is 'acked' or (in
exceptional circumstances) 'nacked' by the server, thereby indicating
that it's been dealt with. A confirm channel has the same methods as a
regular channel, except that `#publish` and `#sendToQueue` return a
promise that will be resolved when the message is acked, or rejected
should it be nacked.

There are, broadly speaking, two uses for confirms. The first is to be
able to act on the information that a message has been accepted, for
example by responding to an upstream request. The second is to rate
limit a publisher by limiting the number of unconfirmed messages it's
allowed.

## `ConfirmChannel(connection)`

This constructor is a channel that uses confirms. It is exported as an
extension point. To obtain such a channel, use `connect` to get a
connection, then call `#createConfirmChannel`.

[amqpurl]: http://www.rabbitmq.com/uri-spec.html
[rabbitmq-tutes]: http://www.rabbitmq.com/getstarted.html
[rabbitmq-confirms]: http://www.rabbitmq.com/confirms.html
[rabbitmq-docs]: http://www.rabbitmq.com/documentation.html
[ssl-doc]: doc/ssl.html
