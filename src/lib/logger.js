const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

function emit(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg: message };
  if (meta && Object.keys(meta).length) line.meta = meta;
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(text);
  else console.log(text);
}

export const log = {
  debug: (m, meta) => emit('debug', m, meta),
  info:  (m, meta) => emit('info', m, meta),
  warn:  (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
};

export default log;
