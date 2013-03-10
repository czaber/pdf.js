#!/bin/bash
for f in `find src -name '*.js'`; do
  sed -i -e 's/\([,=:"return"]\) function .*(/\1 function(/g' $f
done
