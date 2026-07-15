#!/usr/bin/env bun
// Global `pair` entry (bun link / bunx): defers to the TS CLI, which walks
// up from cwd to find the repo's .pair/ — works from any repository.
import '../src/apps/cli/main.ts';
