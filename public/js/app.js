// app.js (raíz del proyecto) — versión completa y robusta

const createError    = require('http-errors');
const express        = require('express');
const path           = require('path');
const cookieParser   = require('cookie-parser');
const logger         = require('morgan');
const session        = require('express-session');
const expressLayouts = require('express-ejs-layouts');

const app = express();

// ====== VIEW ENGINE (EJS) + LAYOUTS ======
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('layout', 'layout'); // si tu layout se llama distinto, cambialo aquí

// ====== MIDDLEWARES BÁSICOS ======
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// 👈 importante: sesiones (usadas en /profes para demoUserId cuando no hay auth real)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-this',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 días
  })
);

// ====== ESTÁTICOS ======
app.use(express.static(path.join(__dirname, 'public')));

// ====== ROUTERS EXISTENTES (opcionales, si tu proyecto ya los tiene) ======
let appPagesRouter = null;
let indexRouter = null;
try { appPagesRouter = require('./routes/app'); } catch (e) { /* opcional */ }
try { indexRouter    = require('./routes/index'); } catch (e) { /* opcional */ }

// Montaje de routers existentes si existen
if (indexRouter)    app.use('/', indexRouter);
if (appPagesRouter) app.use('/', appPagesRouter);

// ====== NUEVA SECCIÓN: PROFESORES ======
// 👈 importante: este es el router que te pasé (routes/profes.js)
const profesRouter = require('./routes/profes');
app.use('/profes', profesRouter);

// ====== 404 (Not Found) ======
app.use(function(req, res, next) {
  next(createError(404));
});

// ====== ERROR HANDLER ======
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  try {
    res.render('error');
  } catch (e) {
    // fallback si no existe views/error.ejs
    res.type('text').send(`Error ${res.statusCode}: ${res.locals.message}`);
  }
});

module.exports = app;
