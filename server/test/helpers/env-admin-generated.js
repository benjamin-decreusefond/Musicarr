import { mkenv } from './mkenv.js';
mkenv({ adminPassword: null });   // no ADMIN_PASSWORD -> generated strong password
