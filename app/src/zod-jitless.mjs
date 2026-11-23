// zod probes once whether it may compile code from a string, as soon as the first object schema is built.
// The panel's Content-Security-Policy forbids that, so the probe fails harmlessly but is still reported as a
// policy violation. Skip the probe. This module must be imported before anything that builds zod schemas
// (src/panel.mjs imports it first, and src/main.mjs imports src/panel.mjs first).
import { config } from 'zod'

config({ jitless: true })
