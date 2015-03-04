var util = require('util'),
  EventEmitter = require('wildemitter'),
  Autowire = require('wantsit').Autowire,
  timeoutify = require('timeoutify')

function noop(){}

var ManagedProcess = function(socket) {
  EventEmitter.call(this, {
    wildcard: true,
    delimiter: ':'
  })

  this._dnode = Autowire
  this._logger = Autowire
  this._config = Autowire

  this._rpc = {}

  this.workers = []

  if(socket) {
    this.socket = socket
  }

  // these methods are defined on the ProcessRPC class - must be kept in sync
  var methods = ['kill', 'restart', 'send', 'reportStatus', 'dumpHeap', 'forceGc', 'write', 'setClusterWorkers']
  methods.forEach(function(method) {
    this[method] = this._invoke.bind(this, method)
  }.bind(this))
}
util.inherits(ManagedProcess, EventEmitter)

ManagedProcess.prototype.update = function(info) {
  for(var key in info) {
    this[key] = info[key]
  }

  if(!this.cluster) {
    // this method is only present on cluster managers
    delete this.setClusterWorkers
    delete this.workers
    delete this.addWorker
  }
}

ManagedProcess.prototype.disconnect = function(callback) {
  if(!this._remote) {
    callback()
  }

  if(callback) {
    this._remote.once('end', callback)
  }

  this._connected = false
  this._remote.end()
}

ManagedProcess.prototype.connect = function(callback) {
  this.once('_connected', callback)

  // don't try to connect more than once
  if(this._connecting) {
    return
  }

  this._connecting = true

  this._remote = this._dnode({
    // forward received events on
    sendEvent: this.emit.bind(this)
  }, {
    timeout: this._config.guvnor.rpctimeout
  })
  this._remote.on('error', this.emit.bind(this, '_connected'))
  this._remote.on('remote', function(remote) {
    this._logger.debug('Connected to remote')

    this._connecting = false
    this._connected = true

    for(var method in remote) {
      if(method == 'send' || method == 'dumpHeap' || method == 'forceGc' || method == 'write') {
        // these are slow or take no callback so don't timeoutify
        this._logger.debug('Exposing remote method %s without timeout', method)
        this._rpc[method] = remote[method].bind(remote)
      } else {
        this._logger.debug('Timeoutifying remote method', method)
        this._rpc[method] = timeoutify(remote[method].bind(remote), this._config.guvnor.timeout)
      }
    }

    this.emit('_connected', undefined, this)
  }.bind(this))

  this._remote.connect(this.socket)
}

ManagedProcess.prototype._invoke = function(method) {
  var args = Array.prototype.slice.call(arguments)
  var callback = args[args.length - 1]

  if(typeof callback != 'function') {
    callback = noop
  }

  // defer execution if we're not connected yet
  if(!this._connected) {
    this.connect(function(args, callback, error) {
      if(error) {
        return callback(error)
      }

      this._invoke.apply(this, args)
    }.bind(this, args, callback))

    return
  }

  // remove the method name from the arguments array
  args = args.slice(1)

  try {
    this._rpc[method].apply(this._rpc, args)
  } catch(error) {
    callback(error)
  }
}

ManagedProcess.prototype.addWorker = function(worker) {
  if(!this.workers.some(function(existingWorker) {
      return existingWorker.id == worker.id
    })) {
    this.workers.push(worker)
  }
}

module.exports = ManagedProcess