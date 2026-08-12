#!/usr/bin/env node

import { main } from '../lib/coverage/cli.js';

const code = await main(process.argv.slice(2));
process.exitCode = code;
