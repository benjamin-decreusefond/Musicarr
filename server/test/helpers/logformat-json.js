// Side-effect: switch the logger to one-JSON-object-per-line, at its most
// verbose level. Import BEFORE log.js (LOG_FORMAT is read at module load).
process.env.LOG_LEVEL = 'debug';
process.env.LOG_FORMAT = 'json';
