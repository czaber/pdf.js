#!/bin/bash
for f in `find src -name '*.js'`; do
  perl -0777 -i.original -pe 's/(\(|\[|,|:|=|return)(\n)?(\s*?)function .*?\(/$1$2$3function\(/g' $f
done
