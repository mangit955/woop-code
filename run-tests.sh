#!/bin/bash
cd "$(dirname "$0")"
bun test packages/tests/runtime packages/tests/tools packages/tests/property
