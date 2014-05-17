'use strict';
var async = require('async');
var restify = require('restify');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var restifyError = function(err) {
  if ('ValidationError' !== err.name) {
    return err;
  }

  return new restify.InvalidContentError('Validation failed' + err.errors);
};

var onError = function(err, next) {
  return next(restifyError(err));
};

var emitEvent = function(self, event) {
  return function(model, cb) {
    self.emit(event, model);

    if (cb) {
      cb(undefined, model);
    }
  }
};

var sendData = function(res) {
  return function(model, cb) {
    res.send(model);
    cb(undefined, model);
  }
};

var execQuery = function(query) {
  return function(cb) {
    query.exec(cb);
  }
};

var execSave = function (model) {
  return function(cb) {
    model.save(function(err, model) {
      if (err)
        return cb(restifyError(err));
      else
        cb(null, model);
    });
  };
};

var setLocationHeader = function (req, res) {
  return function(model, cb) {
    res.header('Location', req.url + '/' + model._id);
    cb(null, model);
  };
}

var buildProjections = function(req, projection) {
  return function(models, cb) {
    var iterator = function (model, cb) {
      projection(req, model, cb);
    };

    async.map(models, iterator, cb);
  }
};

var buildProjection = function(req, projection) {
  return function(model, cb) {
    if (!model) {
      return cb(new restify.ResourceNotFoundError(req.params.id));
    }

    projection(req, model, cb);
  }
};

var Resource = function (Model, options) {
  EventEmitter.call(this);
  this.Model = Model;

  this.options = options || {};
  this.options.pageSize = this.options.pageSize || 100;
  this.options.listProjection = this.options.listProjection || function (req, item, cb) {
    cb(null, item);
  };
  this.options.detailProjection = this.options.detailProjection || function (req, item, cb) {
    cb(null, item);
  };
};

util.inherits(Resource, EventEmitter);

Resource.prototype.query = function (options) {
  var self = this;

  options = options || {};
  options.pageSize = options.pageSize || this.options.pageSize;
  options.projection = options.projection || this.options.listProjection;

  return function (req, res, next) {
    var query = self.Model.find({});

    if (req.query.q) {
      try {
        var q = JSON.parse(req.query.q);
        query = query.where(q);
      } catch (err) {
        return res.send(400, { message: 'Query is not a valid JSON object', errors: err });
      }
    }

    if (req.query.sort) {
      query = query.sort(req.query.sort);
    }

    if (req.query.select) {
      query = query.select(req.query.select);
    }

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    var page = req.query.p || 0;
    query.skip(options.pageSize * page);
    query.limit(options.pageSize);

    async.waterfall([
      execQuery(query),
      buildProjections(req, options.projection),
      emitEvent(self, 'query'),
      sendData(res)
    ], next);
  };
};

Resource.prototype.detail = function (options) {
  var self = this;

  options = options || {};
  options.projection = options.projection || this.options.detailProjection;
  return function (req, res, next) {
    var query = self.Model.findOne({ _id: req.params.id});

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    async.waterfall([
      execQuery(query),
      buildProjection(req, options.projection),
      emitEvent(self, 'detail'),
      sendData(res)
    ], next);
  };
};

Resource.prototype.insert = function () {
  var self = this;

  return function(req, res, next) {
    var model = new self.Model(req.body);
    async.waterfall([
      execSave(model),
      setLocationHeader(req, res),
      emitEvent(self, 'insert'),
      sendData(res)
    ], next);
  };
};

Resource.prototype.update = function () {
  var self = this;

  return function (req, res, next) {
    var query = self.Model.findOne({ _id: req.params.id});

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    query.exec(function (err, model) {
      if (err) {
        return next(err);
      }

      if (!model) {
        return next(new restify.ResourceNotFoundError(req.params.id));
      }

      if (!req.body) {
        return next(new restify.InvalidContentError('No update data sent'));
      }

      model.set(req.body);
      
      async.waterfall([
        execSave(model),
        setLocationHeader(req, res),
        emitEvent(self, 'update'),
        sendData(res)
      ], next);
    });
  };
};

Resource.prototype.remove = function () {
  var self = this;
  var emitRemove = emitEvent(self, 'remove');

  return function (req, res, next) {
    var query = self.Model.findOne({ _id: req.params.id});

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    query.exec(function (err, model) {
      if (err) {
        return next(err);
      }

      if (!model) {
        return next(new restify.ResourceNotFoundError(req.params.id));
      }

      model.remove(function (err) {
        if (err) {
          return next(err);
        }

        res.send(200, model);
        emitRemove(model, next);
      });
    });
  };
};

Resource.prototype.serve = function (path, server) {
  var closedPath = path[path.length - 1] === '/' ? path : path + '/';

  server.get(path, this.query());
  server.get(closedPath + ':id', this.detail());
  server.post(path, this.insert());
  server.del(closedPath + ':id', this.remove());
  server.patch(closedPath + ':id', this.update());
};

module.exports = function (Model, options) {
  if (!Model) {
    throw new Error('Model argument is required');
  }

  return new Resource(Model, options);
};
