// Tiny flash-message helper backed by the session, so a message set before
// a redirect can be read (once) on the next request.
function flash(req, res, next) {
  const messages = req.session.flash || [];
  req.session.flash = [];
  res.locals.flashMessages = messages;
  req.flash = (type, text) => {
    if (!req.session.flash) req.session.flash = [];
    req.session.flash.push({ type, text });
  };
  next();
}

module.exports = flash;
