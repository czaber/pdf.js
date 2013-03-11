#!/bin/bash
for f in `find src -name '*.js'`; do
  sed -i -e 's/\([,=:"return"]\) function .*(/\1 function(/g' $f
  sed -i -e 's/(function .*(/(function(/g' $f
  sed -i -e 's/\[function .*(/(function(/g' $f
done
