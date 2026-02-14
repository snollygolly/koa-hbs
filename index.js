'use strict';

const fs = require('fs');
const path = require('path');
const { glob } = require('glob'); // glob@13+ exports an object; destructure the function

// Capture the layout name; thanks express-hbs
const rLayoutPattern = /{{!<\s+([A-Za-z0-9\._\-\/]+)\s*}}/;

function merge(obj1, obj2) {
  const c = {};
  let keys = Object.keys(obj2);
  for (let i = 0; i !== keys.length; i++) c[keys[i]] = obj2[keys[i]];
  keys = Object.keys(obj1);
  for (let i = 0; i !== keys.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(c, keys[i])) c[keys[i]] = obj1[keys[i]];
  }
  return c;
}

async function read(filename) {
  return fs.promises.readFile(filename, { encoding: 'utf8' });
}

class MissingTemplateError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = this.constructor.name;
    this.extra = extra;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

class BadOptionsError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = this.constructor.name;
    this.extra = extra;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

exports = module.exports = new Hbs();

exports.create = function () {
  return new Hbs();
};

function Hbs() {
  if (!(this instanceof Hbs)) return new Hbs();
  this.handlebars = require('handlebars').create();
  this.Utils = this.handlebars.Utils;
  this.SafeString = this.handlebars.SafeString;
}

Hbs.prototype.configure = function (options) {
  const self = this;

  options = options || {};
  if (!options.viewPath) {
    throw new BadOptionsError('The option `viewPath` must be specified.');
  }

  this.viewPath = options.viewPath;
  this.handlebars = options.handlebars || this.handlebars;
  this.templateOptions = options.templateOptions || {};
  this.extname = options.extname || '.hbs';
  this.partialsPath = options.partialsPath || [];
  this.contentHelperName = options.contentHelperName || 'contentFor';
  this.blockHelperName = options.blockHelperName || 'block';
  this.defaultLayout = options.defaultLayout || '';
  this.layoutsPath = options.layoutsPath || '';
  this.locals = options.locals || {};
  this.disableCache = options.disableCache || false;

  this.partialsRegistered = false;

  if (!Array.isArray(this.viewPath)) this.viewPath = [this.viewPath];

  this.cache = {};
  this.blocks = {};

  this.registerHelper(this.blockHelperName, function (name, options) {
    let val = self.block(name);
    if (val === '' && typeof options.fn === 'function') val = options.fn(this);
    return val;
  });

  this.registerHelper(this.contentHelperName, function (name, options) {
    return self.content(name, options, this);
  });

  return this;
};

/**
 * Koa v2/v3 middleware (async)
 */
Hbs.prototype.middleware = function (options) {
  this.configure(options);
  const render = this.createRenderer();

  return async (ctx, next) => {
    ctx.render = render;
    await next();
  };
};

Hbs.prototype.createRenderer = function () {
  const hbs = this;

  return async function render(tpl, locals) {
    let tplPath = hbs.getTemplatePath(tpl);

    if (path.isAbsolute(tpl)) {
      tplPath = tpl + hbs.extname;
    }

    if (!tplPath) {
      throw new MissingTemplateError('The template specified does not exist.', tplPath);
    }

    locals = merge(this.state || {}, locals || {});
    locals = merge(hbs.locals, locals);

    if (hbs.disableCache || (!hbs.partialsRegistered && hbs.partialsPath !== '')) {
      await hbs.registerPartials();
    }

    if (hbs.disableCache || !hbs.cache[tpl]) {
      const rawTemplate = await read(tplPath);
      hbs.cache[tpl] = { template: hbs.handlebars.compile(rawTemplate) };

      if (typeof locals.layout !== 'undefined' || rLayoutPattern.test(rawTemplate)) {
        let layout = locals.layout;
        if (typeof layout === 'undefined') layout = rLayoutPattern.exec(rawTemplate)[1];

        if (layout !== false) {
          const rawLayout = await hbs.loadLayoutFile(layout);
          hbs.cache[tpl].layoutTemplate = hbs.handlebars.compile(rawLayout);
        } else {
          hbs.cache[tpl].layoutTemplate = hbs.handlebars.compile('{{{body}}}');
        }
      }
    }

    const template = hbs.cache[tpl].template;
    let layoutTemplate = hbs.cache[tpl].layoutTemplate;

    if (!layoutTemplate) {
      layoutTemplate = await hbs.getLayoutTemplate();
    }

    if (!hbs.templateOptions.data) hbs.templateOptions.data = {};
    hbs.templateOptions.data = merge(hbs.templateOptions.data, { koa: this });

    locals.body = template(locals, hbs.templateOptions);
    this.body = layoutTemplate(locals, hbs.templateOptions);
  };
};

Hbs.prototype.getLayoutPath = function (layout) {
  if (this.layoutsPath) return path.join(this.layoutsPath, layout + this.extname);
  return path.join(this.viewPath[0], layout + this.extname);
};

Hbs.prototype.getLayoutTemplate = async function () {
  if (this.disableCache || !this.layoutTemplate) {
    this.layoutTemplate = await this.cacheLayout();
  }
  return this.layoutTemplate;
};

Hbs.prototype.cacheLayout = async function (layout) {
  if (!layout && !this.defaultLayout) {
    return this.handlebars.compile('{{{body}}}');
  }

  if (!layout) layout = this.defaultLayout;

  try {
    const rawLayout = await this.loadLayoutFile(layout);
    return this.handlebars.compile(rawLayout);
  } catch (err) {
    console.error(err.stack || err);
    return undefined;
  }
};

Hbs.prototype.loadLayoutFile = async function (layout) {
  const file = this.getLayoutPath(layout);
  return read(file);
};

Hbs.prototype.registerHelper = function () {
  this.handlebars.registerHelper.apply(this.handlebars, arguments);
};

Hbs.prototype.registerPartial = function () {
  this.handlebars.registerPartial.apply(this.handlebars, arguments);
};

/**
 * glob@13 compatible partial registration (Promise API)
 */
Hbs.prototype.registerPartials = async function () {
  const self = this;

  if (!Array.isArray(this.partialsPath)) this.partialsPath = [this.partialsPath];

  try {
    const resultList = await Promise.all(
      this.partialsPath.map((root) => glob('**/*' + self.extname, { cwd: root }))
    );

    if (!resultList.length) return;

    const files = [];
    const names = [];

    resultList.forEach((result, i) => {
      result.forEach((file) => {
        files.push(path.join(self.partialsPath[i], file));
        names.push(file.slice(0, -1 * self.extname.length));
      });
    });

    const partials = await Promise.all(files.map(read));
    for (let i = 0; i !== partials.length; i++) {
      self.registerPartial(names[i], partials[i]);
    }

    self.partialsRegistered = true;
  } catch (e) {
    console.error('Error caught while registering partials');
    console.error(e);
  }
};

Hbs.prototype.getTemplatePath = function (tpl) {
  const cache = this.pathCache || (this.pathCache = {});
  if (cache[tpl]) return cache[tpl];

  for (let i = 0; i !== this.viewPath.length; i++) {
    const viewPath = this.viewPath[i];
    const tplPath = path.join(viewPath, tpl + this.extname);
    try {
      fs.statSync(tplPath);
      if (!this.disableCache) cache[tpl] = tplPath;
      return tplPath;
    } catch (e) {
      continue;
    }
  }

  return void 0;
};

Hbs.prototype.content = function (name, options, context) {
  const block = this.blocks[name] || (this.blocks[name] = []);
  block.push(options.fn(context));
};

Hbs.prototype.block = function (name) {
  const val = (this.blocks[name] || []).join('\n');
  this.blocks[name] = [];
  return val;
};
