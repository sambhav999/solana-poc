const PREFIX = '[overflow]';

export function serializeError(err) {
  if (err == null) return { value: String(err) };
  if (typeof err !== 'object') return { value: String(err) };
  const out = {
    name: err.name,
    message: err.message,
    code: err.code,
    status: err.status,
    stage: err.stage,
    source: err.source,
    stack: err.stack,
  };
  try {
    out.keys = Object.getOwnPropertyNames(err);
  } catch { /* ignore */ }
  try {
    out.json = JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err)));
  } catch {
    try { out.string = String(err); } catch { /* ignore */ }
  }
  if (err.cause) out.cause = serializeError(err.cause);
  if (err.body) out.body = err.body;
  if (err.data !== undefined) out.data = err.data;
  if (err.error) out.nestedError = serializeError(err.error);
  return out;
}

export function trace(label, data) {
  if (data === undefined) {
    console.info(PREFIX, label);
    return;
  }
  console.info(PREFIX, label, data);
}

export function traceError(label, err) {
  const dump = serializeError(err);
  console.error(PREFIX, label, dump, err);
  return dump;
}

export function tagError(err, { stage, source }) {
  if (err && typeof err === 'object') {
    if (stage && !err.stage) err.stage = stage;
    if (source && !err.source) err.source = source;
    return err;
  }
  const wrapped = new Error(String(err));
  wrapped.stage = stage;
  wrapped.source = source;
  return wrapped;
}
