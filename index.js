'use strict';

const fs = require('fs');
const path = require('path');
const globCb = require('glob');
const util = require('util');

const glob = util.promisify(globCb);

// Capture the layout name; thanks express-hbs
const rLayoutPattern = /{{!<\s+([A-Za-z0-9\._\-\/]+)\s*}}/;

/**
 * Shallow copy two objects into a new object
 *
 * Objects are merged from left to right. Thus, properties in objects further
 * to the right are preferred over those on the left.
 *
 * @param {object} obj1
 * @param {object} obj2
 * @returns {object}
 * @api private
 */
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

/** @param {String} filename */
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

/**
 * expose default instance of `Hbs`
 */
exports = module.exports = new Hbs();

/**
 * expose method to create additional instances of `Hbs`
 */
exports.create = function () {
	return new Hbs();
};

/**
 * Create new instance of `Hbs`
 *
 * @api public
 */
function Hbs() {
	if (!(this instanceof Hbs)) return new Hbs();
	this.handlebars = require('handlebars').create();
	this.Utils = this.handlebars.Utils;
	this.SafeString = this.handlebars.SafeString;
}

/**
 * Configure the instance.
 *
 * @api private
 */
Hbs.prototype.configure = function (options) {
	const self = this;

	options = options || {};
	if (!options.viewPath) {
		throw new BadOptionsError('The option `viewPath` must be specified.');
	}

	// Attach options
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

	// Cache templates and layouts
	this.cache = {};
	this.blocks = {};

	// block helper
	this.registerHelper(this.blockHelperName, function (name, options) {
		let val = self.block(name);
		if (val === '' && typeof options.fn === 'function') val = options.fn(this);
		return val;
	});

	// contentFor helper
	this.registerHelper(this.contentHelperName, function (name, options) {
		return self.content(name, options, this);
	});

	return this;
};

/**
 * Middleware for Koa v2/v3 (async middleware)
 *
 * @api public
 */
Hbs.prototype.middleware = function (options) {
	this.configure(options);
	const render = this.createRenderer();

	return async (ctx, next) => {
		// ensure `this` inside render is the Koa context when called as ctx.render(...)
		ctx.render = render;
		await next();
	};
};

/**
 * Create a render function to be attached to koa context
 */
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

		// Koa locals: ctx.state + passed locals + configured locals
		locals = merge(this.state || {}, locals || {});
		locals = merge(hbs.locals, locals);

		// Register partials once (or always, if cache disabled)
		if (hbs.disableCache || (!hbs.partialsRegistered && hbs.partialsPath !== '')) {
			await hbs.registerPartials();
		}

		// Load/compile template (and optional layout override) into cache
		if (hbs.disableCache || !hbs.cache[tpl]) {
			const rawTemplate = await read(tplPath);
			hbs.cache[tpl] = {
				template: hbs.handlebars.compile(rawTemplate),
			};

			// Load layout if specified
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

		// Provide Koa context to helpers via templateOptions.data.koa
		if (!hbs.templateOptions.data) hbs.templateOptions.data = {};
		hbs.templateOptions.data = merge(hbs.templateOptions.data, { koa: this });

		// Run the compiled templates
		locals.body = template(locals, hbs.templateOptions);
		this.body = layoutTemplate(locals, hbs.templateOptions);
	};
};

/** Get layout path */
Hbs.prototype.getLayoutPath = function (layout) {
	if (this.layoutsPath) return path.join(this.layoutsPath, layout + this.extname);
	return path.join(this.viewPath[0], layout + this.extname);
};

/** Lazy load default layout in cache. */
Hbs.prototype.getLayoutTemplate = async function () {
	if (this.disableCache || !this.layoutTemplate) {
		this.layoutTemplate = await this.cacheLayout();
	}
	return this.layoutTemplate;
};

/** Get a default layout. If none is provided, make a noop */
Hbs.prototype.cacheLayout = async function (layout) {
	// Create a default layout to always use if none is specified
	if (!layout && !this.defaultLayout) {
		return this.handlebars.compile('{{{body}}}');
	}

	if (!layout) layout = this.defaultLayout;

	try {
		const rawLayout = await this.loadLayoutFile(layout);
		return this.handlebars.compile(rawLayout);
	} catch (err) {
		// preserve previous behavior (log and return undefined)
		console.error(err.stack || err);
		return undefined;
	}
};

/** Load a layout file */
Hbs.prototype.loadLayoutFile = async function (layout) {
	const file = this.getLayoutPath(layout);
	return read(file);
};

/** Register helper to internal handlebars instance */
Hbs.prototype.registerHelper = function () {
	this.handlebars.registerHelper.apply(this.handlebars, arguments);
};

/** Register partial with internal handlebars instance */
Hbs.prototype.registerPartial = function () {
	this.handlebars.registerPartial.apply(this.handlebars, arguments);
};

/** Register directory of partials */
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

		// Generate list of files and template names
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

/** The contentFor helper delegates to here to populate block content */
Hbs.prototype.content = function (name, options, context) {
	const block = this.blocks[name] || (this.blocks[name] = []);
	block.push(options.fn(context));
};

/** block helper delegates to this function to retreive content */
Hbs.prototype.block = function (name) {
	const val = (this.blocks[name] || []).join('\n');
	this.blocks[name] = [];
	return val;
};
