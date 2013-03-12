/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals ColorSpace, DeviceCmykCS, DeviceGrayCS, DeviceRgbCS, error,
           FONT_IDENTITY_MATRIX, IDENTITY_MATRIX, ImageData, isArray, isNum,
           isString, Pattern, TilingPattern, TODO, Util, warn */

'use strict';

// <canvas> contexts store most of the state we need natively.
// However, PDF needs a bit more state, which we store here.

var TextRenderingMode = {
  FILL: 0,
  STROKE: 1,
  FILL_STROKE: 2,
  INVISIBLE: 3,
  FILL_ADD_TO_PATH: 4,
  STROKE_ADD_TO_PATH: 5,
  FILL_STROKE_ADD_TO_PATH: 6,
  ADD_TO_PATH: 7,
  ADD_TO_PATH_FLAG: 4
};

// Minimal font size that would be used during canvas fillText operations.
var MIN_FONT_SIZE = 1;

function createScratchCanvas(width, height) {
  var canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function addContextCurrentTransform(ctx) {
  // If the context doesn't expose a `mozCurrentTransform`, add a JS based on.
  if (!ctx.mozCurrentTransform) {
    // Store the original context
    ctx._scaleX = ctx._scaleX || 1.0;
    ctx._scaleY = ctx._scaleY || 1.0;
    ctx._originalSave = ctx.save;
    ctx._originalRestore = ctx.restore;
    ctx._originalRotate = ctx.rotate;
    ctx._originalScale = ctx.scale;
    ctx._originalTranslate = ctx.translate;
    ctx._originalTransform = ctx.transform;

    ctx._transformMatrix = [ctx._scaleX, 0, 0, ctx._scaleY, 0, 0];
    ctx._transformStack = [];

    Object.defineProperty(ctx, 'mozCurrentTransform', {
      get: function() {
        return this._transformMatrix;
      }
    });

    Object.defineProperty(ctx, 'mozCurrentTransformInverse', {
      get: function() {
        // Calculation done using WolframAlpha:
        // http://www.wolframalpha.com/input/?
        //   i=Inverse+{{a%2C+c%2C+e}%2C+{b%2C+d%2C+f}%2C+{0%2C+0%2C+1}}

        var m = this._transformMatrix;
        var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];

        var ad_bc = a * d - b * c;
        var bc_ad = b * c - a * d;

        return [
          d / ad_bc,
          b / bc_ad,
          c / bc_ad,
          a / ad_bc,
          (d * e - c * f) / bc_ad,
          (b * e - a * f) / ad_bc
        ];
      }
    });

    ctx.save = function() {
      var old = this._transformMatrix;
      this._transformStack.push(old);
      this._transformMatrix = old.slice(0, 6);

      this._originalSave();
    };

    ctx.restore = function() {
      var prev = this._transformStack.pop();
      if (prev) {
        this._transformMatrix = prev;
        this._originalRestore();
      }
    };

    ctx.translate = function(x, y) {
      var m = this._transformMatrix;
      m[4] = m[0] * x + m[2] * y + m[4];
      m[5] = m[1] * x + m[3] * y + m[5];

      this._originalTranslate(x, y);
    };

    ctx.scale = function(x, y) {
      var m = this._transformMatrix;
      m[0] = m[0] * x;
      m[1] = m[1] * x;
      m[2] = m[2] * y;
      m[3] = m[3] * y;

      this._originalScale(x, y);
    };

    ctx.transform = function(a, b, c, d, e, f) {
      var m = this._transformMatrix;
      this._transformMatrix = [
        m[0] * a + m[2] * b,
        m[1] * a + m[3] * b,
        m[0] * c + m[2] * d,
        m[1] * c + m[3] * d,
        m[0] * e + m[2] * f + m[4],
        m[1] * e + m[3] * f + m[5]
      ];

      ctx._originalTransform(a, b, c, d, e, f);
    };

    ctx.rotate = function(angle) {
      var cosValue = Math.cos(angle);
      var sinValue = Math.sin(angle);

      var m = this._transformMatrix;
      this._transformMatrix = [
        m[0] * cosValue + m[2] * sinValue,
        m[1] * cosValue + m[3] * sinValue,
        m[0] * (-sinValue) + m[2] * cosValue,
        m[1] * (-sinValue) + m[3] * cosValue,
        m[4],
        m[5]
      ];

      this._originalRotate(angle);
    };
  }
}

var CanvasExtraState = (function() {
  function CanvasExtraState(old) {
    // Are soft masks and alpha values shapes or opacities?
    this.alphaIsShape = false;
    this.fontSize = 0;
    this.fontSizeScale = 1;
    this.textMatrix = IDENTITY_MATRIX;
    this.fontMatrix = FONT_IDENTITY_MATRIX;
    this.leading = 0;
    // Current point (in user coordinates)
    this.x = 0;
    this.y = 0;
    // Start of text line (in text coordinates)
    this.lineX = 0;
    this.lineY = 0;
    // Character and word spacing
    this.charSpacing = 0;
    this.wordSpacing = 0;
    this.textHScale = 1;
    this.textRenderingMode = TextRenderingMode.FILL;
    this.textRise = 0;
    // Color spaces
    this.fillColorSpace = new DeviceGrayCS();
    this.fillColorSpaceObj = null;
    this.strokeColorSpace = new DeviceGrayCS();
    this.strokeColorSpaceObj = null;
    this.fillColorObj = null;
    this.strokeColorObj = null;
    // Default fore and background colors
    this.fillColor = '#000000';
    this.strokeColor = '#000000';
    // Note: fill alpha applies to all non-stroking operations
    this.fillAlpha = 1;
    this.strokeAlpha = 1;
    this.lineWidth = 1;
    this.paintFormXObjectDepth = 0;

    this.old = old;
  }

  CanvasExtraState.prototype = {
    clone: function() {
      return Object.create(this);
    },
    setCurrentPoint: function(x, y) {
      this.x = x;
      this.y = y;
    }
  };
  return CanvasExtraState;
})();

var CanvasGraphics = (function() {
  // Defines the time the executeOperatorList is going to be executing
  // before it stops and shedules a continue of execution.
  var EXECUTION_TIME = 15;

  function CanvasGraphics(canvasCtx, commonObjs, objs, textLayer, imageLayer) {
    this.ctx = canvasCtx;
    this.current = new CanvasExtraState();
    this.stateStack = [];
    this.pendingClip = null;
    this.res = null;
    this.xobjs = null;
    this.commonObjs = commonObjs;
    this.objs = objs;
    this.textLayer = textLayer;
    this.imageLayer = imageLayer;
    if (canvasCtx) {
      addContextCurrentTransform(canvasCtx);
    }
  }

  function applyStencilMask(imgArray, width, height, inverseDecode, buffer) {
    var imgArrayPos = 0;
    var i, j, mask, buf;
    // removing making non-masked pixels transparent
    var bufferPos = 3; // alpha component offset
    for (i = 0; i < height; i++) {
      mask = 0;
      for (j = 0; j < width; j++) {
        if (!mask) {
          buf = imgArray[imgArrayPos++];
          mask = 128;
        }
        if (!(buf & mask) === inverseDecode) {
          buffer[bufferPos] = 0;
        }
        bufferPos += 4;
        mask >>= 1;
      }
    }
  }

  function putBinaryImageData(ctx, data, w, h) {
    var tmpImgData = 'createImageData' in ctx ? ctx.createImageData(w, h) :
      ctx.getImageData(0, 0, w, h);

    var tmpImgDataPixels = tmpImgData.data;
    if ('set' in tmpImgDataPixels)
      tmpImgDataPixels.set(data);
    else {
      // Copy over the imageData pixel by pixel.
      for (var i = 0, ii = tmpImgDataPixels.length; i < ii; i++)
        tmpImgDataPixels[i] = data[i];
    }

    ctx.putImageData(tmpImgData, 0, 0);
  }

  function prescaleImage(pixels, width, height, widthScale, heightScale) {
    pixels = new Uint8Array(pixels); // creating a copy
    while (widthScale > 2 || heightScale > 2) {
      if (heightScale > 2) {
        // scaling image twice vertically
        var rowSize = width * 4;
        var k = 0, l = 0;
        for (var i = 0; i < height - 1; i += 2) {
          for (var j = 0; j < width; j++) {
            var alpha1 = pixels[k + 3], alpha2 = pixels[k + 3 + rowSize];
            if (alpha1 === alpha2) {
              pixels[l] = (pixels[k] + pixels[k + rowSize]) >> 1;
              pixels[l + 1] = (pixels[k + 1] + pixels[k + 1 + rowSize]) >> 1;
              pixels[l + 2] = (pixels[k + 2] + pixels[k + 2 + rowSize]) >> 1;
              pixels[l + 3] = alpha1;
            } else if (alpha1 < alpha2) {
              var d = 256 - alpha2 + alpha1;
              pixels[l] = (pixels[k] * d + (pixels[k + rowSize] << 8)) >> 9;
              pixels[l + 1] = (pixels[k + 1] * d +
                              (pixels[k + 1 + rowSize] << 8)) >> 9;
              pixels[l + 2] = (pixels[k + 2] * d +
                              (pixels[k + 2 + rowSize] << 8)) >> 9;
              pixels[l + 3] = alpha2;
            } else {
              var d = 256 - alpha1 + alpha2;
              pixels[l] = ((pixels[k] << 8) + pixels[k + rowSize] * d) >> 9;
              pixels[l + 1] = ((pixels[k + 1] << 8) +
                              pixels[k + 1 + rowSize] * d) >> 9;
              pixels[l + 2] = ((pixels[k + 2] << 8) +
                              pixels[k + 2 + rowSize] * d) >> 9;
              pixels[l + 3] = alpha1;
            }
            k += 4; l += 4;
          }
          k += rowSize;
        }
        if (height & 1) {
          for (var i = 0; i < rowSize; i++) {
            pixels[l++] = pixels[k++];
          }
        }
        height = (height + 1) >> 1;
        heightScale /= 2;
      }
      if (widthScale > 2) {
        // scaling image twice horizontally
        var k = 0, l = 0;
        for (var i = 0; i < height; i++) {
          for (var j = 0; j < width - 1; j += 2) {
            var alpha1 = pixels[k + 3], alpha2 = pixels[k + 7];
            if (alpha1 === alpha2) {
              pixels[l] = (pixels[k] + pixels[k + 4]) >> 1;
              pixels[l + 1] = (pixels[k + 1] + pixels[k + 5]) >> 1;
              pixels[l + 2] = (pixels[k + 2] + pixels[k + 6]) >> 1;
              pixels[l + 3] = alpha1;
            } else if (alpha1 < alpha2) {
              var d = 256 - alpha2 + alpha1;
              pixels[l] = (pixels[k] * d + (pixels[k + 4] << 8)) >> 9;
              pixels[l + 1] = (pixels[k + 1] * d + (pixels[k + 5] << 8)) >> 9;
              pixels[l + 2] = (pixels[k + 2] * d + (pixels[k + 6] << 8)) >> 9;
              pixels[l + 3] = alpha2;
            } else {
              var d = 256 - alpha1 + alpha2;
              pixels[l] = ((pixels[k] << 8) + pixels[k + 4] * d) >> 9;
              pixels[l + 1] = ((pixels[k + 1] << 8) + pixels[k + 5] * d) >> 9;
              pixels[l + 2] = ((pixels[k + 2] << 8) + pixels[k + 6] * d) >> 9;
              pixels[l + 3] = alpha1;
            }
            k += 8; l += 4;
          }
          if (width & 1) {
            pixels[l++] = pixels[k++];
            pixels[l++] = pixels[k++];
            pixels[l++] = pixels[k++];
            pixels[l++] = pixels[k++];
          }
        }
        width = (width + 1) >> 1;
        widthScale /= 2;
      }
    }

    var tmpCanvas = createScratchCanvas(width, height);
    var tmpCtx = tmpCanvas.getContext('2d');
    putBinaryImageData(tmpCtx, pixels.subarray(0, width * height * 4),
                               width, height);

    return tmpCanvas;
  }

  var LINE_CAP_STYLES = ['butt', 'round', 'square'];
  var LINE_JOIN_STYLES = ['miter', 'round', 'bevel'];
  var NORMAL_CLIP = {};
  var EO_CLIP = {};

  CanvasGraphics.prototype = {
    slowCommands: {
      'stroke': true,
      'closeStroke': true,
      'fill': true,
      'eoFill': true,
      'fillStroke': true,
      'eoFillStroke': true,
      'closeFillStroke': true,
      'closeEOFillStroke': true,
      'showText': true,
      'showSpacedText': true,
      'setStrokeColorSpace': true,
      'setFillColorSpace': true,
      'setStrokeColor': true,
      'setStrokeColorN': true,
      'setFillColor': true,
      'setFillColorN': true,
      'setStrokeGray': true,
      'setFillGray': true,
      'setStrokeRGBColor': true,
      'setFillRGBColor': true,
      'setStrokeCMYKColor': true,
      'setFillCMYKColor': true,
      'paintJpegXObject': true,
      'paintImageXObject': true,
      'paintInlineImageXObject': true,
      'paintInlineImageXObjectGroup': true,
      'paintImageMaskXObject': true,
      'paintImageMaskXObjectGroup': true,
      'shadingFill': true
    },

    beginDrawing: function(viewport) {
      var transform = viewport.transform;
      this.ctx.save();
      this.ctx.transform.apply(this.ctx, transform);

      if (this.textLayer) {
        this.textLayer.beginLayout();
      }
      if (this.imageLayer) {
        this.imageLayer.beginLayout();
      }
    },

    executeOperatorList: function(
                                    operatorList,
                                    executionStartIdx, continueCallback,
                                    stepper) {
      var argsArray = operatorList.argsArray;
      var fnArray = operatorList.fnArray;
      var i = executionStartIdx || 0;
      var argsArrayLen = argsArray.length;

      // Sometimes the OperatorList to execute is empty.
      if (argsArrayLen == i) {
        return i;
      }

      var executionEndIdx;
      var endTime = Date.now() + EXECUTION_TIME;

      var commonObjs = this.commonObjs;
      var objs = this.objs;
      var fnName;
      var slowCommands = this.slowCommands;

      while (true) {
        if (stepper && i === stepper.nextBreakPoint) {
          stepper.breakIt(i, continueCallback);
          return i;
        }

        fnName = fnArray[i];

        if (fnName !== 'dependency') {
          this[fnName].apply(this, argsArray[i]);
        } else {
          var deps = argsArray[i];
          for (var n = 0, nn = deps.length; n < nn; n++) {
            var depObjId = deps[n];
            var common = depObjId.substring(0, 2) == 'g_';

            // If the promise isn't resolved yet, add the continueCallback
            // to the promise and bail out.
            if (!common && !objs.isResolved(depObjId)) {
              objs.get(depObjId, continueCallback);
              return i;
            }
            if (common && !commonObjs.isResolved(depObjId)) {
              commonObjs.get(depObjId, continueCallback);
              return i;
            }
          }
        }

        i++;

        // If the entire operatorList was executed, stop as were done.
        if (i == argsArrayLen) {
          return i;
        }

        // If the execution took longer then a certain amount of time, shedule
        // to continue exeution after a short delay.
        // However, this is only possible if a 'continueCallback' is passed in.
        if (continueCallback && slowCommands[fnName] && Date.now() > endTime) {
          setTimeout(continueCallback, 0);
          return i;
        }

        // If the operatorList isn't executed completely yet OR the execution
        // time was short enough, do another execution round.
      }
    },

    endDrawing: function() {
      this.ctx.restore();

      if (this.textLayer) {
        this.textLayer.endLayout();
      }
      if (this.imageLayer) {
        this.imageLayer.endLayout();
      }
    },

    // Graphics state
    setLineWidth: function(width) {
      this.current.lineWidth = width;
      this.ctx.lineWidth = width;
    },
    setLineCap: function(style) {
      this.ctx.lineCap = LINE_CAP_STYLES[style];
    },
    setLineJoin: function(style) {
      this.ctx.lineJoin = LINE_JOIN_STYLES[style];
    },
    setMiterLimit: function(limit) {
      this.ctx.miterLimit = limit;
    },
    setDash: function(dashArray, dashPhase) {
      var ctx = this.ctx;
      if ('setLineDash' in ctx) {
        ctx.setLineDash(dashArray);
        ctx.lineDashOffset = dashPhase;
      } else {
        ctx.mozDash = dashArray;
        ctx.mozDashOffset = dashPhase;
      }
    },
    setRenderingIntent: function(intent) {
      // Maybe if we one day fully support color spaces this will be important
      // for now we can ignore.
      // TODO set rendering intent?
    },
    setFlatness: function(flatness) {
      // There's no way to control this with canvas, but we can safely ignore.
      // TODO set flatness?
    },
    setGState: function(states) {
      for (var i = 0, ii = states.length; i < ii; i++) {
        var state = states[i];
        var key = state[0];
        var value = state[1];

        switch (key) {
          case 'LW':
            this.setLineWidth(value);
            break;
          case 'LC':
            this.setLineCap(value);
            break;
          case 'LJ':
            this.setLineJoin(value);
            break;
          case 'ML':
            this.setMiterLimit(value);
            break;
          case 'D':
            this.setDash(value[0], value[1]);
            break;
          case 'RI':
            this.setRenderingIntent(value);
            break;
          case 'FL':
            this.setFlatness(value);
            break;
          case 'Font':
            this.setFont(state[1], state[2]);
            break;
          case 'CA':
            this.current.strokeAlpha = state[1];
            break;
          case 'ca':
            this.current.fillAlpha = state[1];
            this.ctx.globalAlpha = state[1];
            break;
        }
      }
    },
    save: function() {
      this.ctx.save();
      var old = this.current;
      this.stateStack.push(old);
      this.current = old.clone();
    },
    restore: function() {
      if ('textClipLayers' in this) {
        this.completeTextClipping();
      }

      var prev = this.stateStack.pop();
      if (prev) {
        this.current = prev;
        this.ctx.restore();
      }
    },
    transform: function(a, b, c, d, e, f) {
      this.ctx.transform(a, b, c, d, e, f);
    },

    // Path
    moveTo: function(x, y) {
      this.ctx.moveTo(x, y);
      this.current.setCurrentPoint(x, y);
    },
    lineTo: function(x, y) {
      this.ctx.lineTo(x, y);
      this.current.setCurrentPoint(x, y);
    },
    curveTo: function(x1, y1, x2, y2, x3, y3) {
      this.ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3);
      this.current.setCurrentPoint(x3, y3);
    },
    curveTo2: function(x2, y2, x3, y3) {
      var current = this.current;
      this.ctx.bezierCurveTo(current.x, current.y, x2, y2, x3, y3);
      current.setCurrentPoint(x3, y3);
    },
    curveTo3: function(x1, y1, x3, y3) {
      this.curveTo(x1, y1, x3, y3, x3, y3);
      this.current.setCurrentPoint(x3, y3);
    },
    closePath: function() {
      this.ctx.closePath();
    },
    rectangle: function(x, y, width, height) {
      this.ctx.rect(x, y, width, height);
    },
    stroke: function(consumePath) {
      consumePath = typeof consumePath !== 'undefined' ? consumePath : true;
      var ctx = this.ctx;
      var strokeColor = this.current.strokeColor;
      if (this.current.lineWidth === 0)
        ctx.lineWidth = this.getSinglePixelWidth();
      // For stroke we want to temporarily change the global alpha to the
      // stroking alpha.
      ctx.globalAlpha = this.current.strokeAlpha;
      if (strokeColor && strokeColor.hasOwnProperty('type') &&
          strokeColor.type === 'Pattern') {
        // for patterns, we transform to pattern space, calculate
        // the pattern, call stroke, and restore to user space
        ctx.save();
        ctx.strokeStyle = strokeColor.getPattern(ctx);
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.stroke();
      }
      if (consumePath)
        this.consumePath();
      // Restore the global alpha to the fill alpha
      ctx.globalAlpha = this.current.fillAlpha;
    },
    closeStroke: function() {
      this.closePath();
      this.stroke();
    },
    fill: function(consumePath) {
      consumePath = typeof consumePath !== 'undefined' ? consumePath : true;
      var ctx = this.ctx;
      var fillColor = this.current.fillColor;

      if (fillColor && fillColor.hasOwnProperty('type') &&
          fillColor.type === 'Pattern') {
        ctx.save();
        ctx.fillStyle = fillColor.getPattern(ctx);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fill();
      }
      if (consumePath)
        this.consumePath();
    },
    eoFill: function() {
      var savedFillRule = this.setEOFillRule();
      this.fill();
      this.restoreFillRule(savedFillRule);
    },
    fillStroke: function() {
      this.fill(false);
      this.stroke(false);

      this.consumePath();
    },
    eoFillStroke: function() {
      var savedFillRule = this.setEOFillRule();
      this.fillStroke();
      this.restoreFillRule(savedFillRule);
    },
    closeFillStroke: function() {
      this.closePath();
      this.fillStroke();
    },
    closeEOFillStroke: function() {
      var savedFillRule = this.setEOFillRule();
      this.closePath();
      this.fillStroke();
      this.restoreFillRule(savedFillRule);
    },
    endPath: function() {
      this.consumePath();
    },

    // Clipping
    clip: function() {
      this.pendingClip = NORMAL_CLIP;
    },
    eoClip: function() {
      this.pendingClip = EO_CLIP;
    },

    // Text
    beginText: function() {
      this.current.textMatrix = IDENTITY_MATRIX;
      this.current.x = this.current.lineX = 0;
      this.current.y = this.current.lineY = 0;
    },
    endText: function() {
      if ('textClipLayers' in this) {
        this.swapImageForTextClipping();
      }
    },
    getCurrentTextClipping: function() {
      var ctx = this.ctx;
      var transform = ctx.mozCurrentTransform;
      if ('textClipLayers' in this) {
        // we need to reset only font and transform
        var maskCtx = this.textClipLayers.maskCtx;
        maskCtx.setTransform.apply(maskCtx, transform);
        maskCtx.font = ctx.font;
        return maskCtx;
      }

      var canvasWidth = ctx.canvas.width;
      var canvasHeight = ctx.canvas.height;
      // keeping track of the text clipping of the separate canvas
      var maskCanvas = createScratchCanvas(canvasWidth, canvasHeight);
      var maskCtx = maskCanvas.getContext('2d');
      maskCtx.setTransform.apply(maskCtx, transform);
      maskCtx.font = ctx.font;
      var textClipLayers = {
        maskCanvas: maskCanvas,
        maskCtx: maskCtx
      };
      this.textClipLayers = textClipLayers;
      return maskCtx;
    },
    swapImageForTextClipping:
      function() {
      var ctx = this.ctx;
      var canvasWidth = ctx.canvas.width;
      var canvasHeight = ctx.canvas.height;
      // saving current image content and clearing whole canvas
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      var data = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
      this.textClipLayers.imageData = data;
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.restore();
    },
    completeTextClipping: function() {
      var ctx = this.ctx;
      // applying mask to the image (result is saved in maskCanvas)
      var maskCtx = this.textClipLayers.maskCtx;
      maskCtx.setTransform(1, 0, 0, 1, 0, 0);
      maskCtx.globalCompositeOperation = 'source-in';
      maskCtx.drawImage(ctx.canvas, 0, 0);

      // restoring image data and applying the result of masked drawing
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.putImageData(this.textClipLayers.imageData, 0, 0);
      ctx.drawImage(this.textClipLayers.maskCanvas, 0, 0);
      ctx.restore();

      delete this.textClipLayers;
    },
    setCharSpacing: function(spacing) {
      this.current.charSpacing = spacing;
    },
    setWordSpacing: function(spacing) {
      this.current.wordSpacing = spacing;
    },
    setHScale: function(scale) {
      this.current.textHScale = scale / 100;
    },
    setLeading: function(leading) {
      this.current.leading = -leading;
    },
    setFont: function(fontRefName, size) {
      var fontObj = this.commonObjs.get(fontRefName);
      var current = this.current;

      if (!fontObj)
        error('Can\'t find font for ' + fontRefName);

      current.fontMatrix = fontObj.fontMatrix ? fontObj.fontMatrix :
                                                FONT_IDENTITY_MATRIX;

      // A valid matrix needs all main diagonal elements to be non-zero
      // This also ensures we bypass FF bugzilla bug #719844.
      if (current.fontMatrix[0] === 0 ||
          current.fontMatrix[3] === 0) {
        warn('Invalid font matrix for font ' + fontRefName);
      }

      // The spec for Tf (setFont) says that 'size' specifies the font 'scale',
      // and in some docs this can be negative (inverted x-y axes).
      if (size < 0) {
        size = -size;
        current.fontDirection = -1;
      } else {
        current.fontDirection = 1;
      }

      this.current.font = fontObj;
      this.current.fontSize = size;

      if (fontObj.coded)
        return; // we don't need ctx.font for Type3 fonts

      var name = fontObj.loadedName || 'sans-serif';
      var bold = fontObj.black ? (fontObj.bold ? 'bolder' : 'bold') :
                                 (fontObj.bold ? 'bold' : 'normal');

      var italic = fontObj.italic ? 'italic' : 'normal';
      var typeface = '"' + name + '", ' + fontObj.fallbackName;

      // Some font backends cannot handle fonts below certain size.
      // Keeping the font at minimal size and using the fontSizeScale to change
      // the current transformation matrix before the fillText/strokeText.
      // See https://bugzilla.mozilla.org/show_bug.cgi?id=726227
      var browserFontSize = size >= MIN_FONT_SIZE ? size : MIN_FONT_SIZE;
      this.current.fontSizeScale = browserFontSize != MIN_FONT_SIZE ? 1.0 :
                                   size / MIN_FONT_SIZE;

      var rule = italic + ' ' + bold + ' ' + browserFontSize + 'px ' + typeface;
      this.ctx.font = rule;
    },
    setTextRenderingMode: function(mode) {
      this.current.textRenderingMode = mode;
    },
    setTextRise: function(rise) {
      this.current.textRise = rise;
    },
    moveText: function(x, y) {
      this.current.x = this.current.lineX += x;
      this.current.y = this.current.lineY += y;
    },
    setLeadingMoveText: function(x, y) {
      this.setLeading(-y);
      this.moveText(x, y);
    },
    setTextMatrix: function(a, b, c, d, e, f) {
      this.current.textMatrix = [a, b, c, d, e, f];

      this.current.x = this.current.lineX = 0;
      this.current.y = this.current.lineY = 0;
    },
    nextLine: function() {
      this.moveText(0, this.current.leading);
    },
    applyTextTransforms: function() {
      var ctx = this.ctx;
      var current = this.current;
      ctx.transform.apply(ctx, current.textMatrix);
      ctx.translate(current.x, current.y + current.textRise);
      if (current.fontDirection > 0) {
        ctx.scale(current.textHScale, -1);
      } else {
        ctx.scale(-current.textHScale, 1);
      }
    },
    createTextGeometry: function() {
      var geometry = {};
      var ctx = this.ctx;
      var font = this.current.font;
      var ctxMatrix = ctx.mozCurrentTransform;
      if (ctxMatrix) {
        var bl = Util.applyTransform([0, 0], ctxMatrix);
        var tr = Util.applyTransform([1, 1], ctxMatrix);
        geometry.x = bl[0];
        geometry.y = bl[1];
        geometry.hScale = tr[0] - bl[0];
        geometry.vScale = tr[1] - bl[1];
      }
      geometry.spaceWidth = font.spaceWidth;
      geometry.fontName = font.loadedName;
      geometry.fontFamily = font.fallbackName;
      geometry.fontSize = this.current.fontSize;
      return geometry;
    },

    showText: function(str, skipTextSelection) {
      var ctx = this.ctx;
      var current = this.current;
      var font = current.font;
      var glyphs = font.charsToGlyphs(str);
      var fontSize = current.fontSize;
      var fontSizeScale = current.fontSizeScale;
      var charSpacing = current.charSpacing;
      var wordSpacing = current.wordSpacing;
      var textHScale = current.textHScale * current.fontDirection;
      var fontMatrix = current.fontMatrix || FONT_IDENTITY_MATRIX;
      var glyphsLength = glyphs.length;
      var textLayer = this.textLayer;
      var geom;
      var textSelection = textLayer && !skipTextSelection ? true : false;
      var textRenderingMode = current.textRenderingMode;
      var canvasWidth = 0.0;
      var vertical = font.vertical;
      var defaultVMetrics = font.defaultVMetrics;

      // Type3 fonts - each glyph is a "mini-PDF"
      if (font.coded) {
        ctx.save();
        ctx.transform.apply(ctx, current.textMatrix);
        ctx.translate(current.x, current.y);

        ctx.scale(textHScale, 1);

        if (textSelection) {
          this.save();
          ctx.scale(1, -1);
          geom = this.createTextGeometry();
          this.restore();
        }
        for (var i = 0; i < glyphsLength; ++i) {

          var glyph = glyphs[i];
          if (glyph === null) {
            // word break
            this.ctx.translate(wordSpacing, 0);
            current.x += wordSpacing * textHScale;
            continue;
          }

          this.save();
          ctx.scale(fontSize, fontSize);
          ctx.transform.apply(ctx, fontMatrix);
          this.executeOperatorList(glyph.operatorList);
          this.restore();

          var transformed = Util.applyTransform([glyph.width, 0], fontMatrix);
          var width = (transformed[0] * fontSize + charSpacing) *
                      current.fontDirection;

          ctx.translate(width, 0);
          current.x += width * textHScale;

          canvasWidth += width;
        }
        ctx.restore();
      } else {
        ctx.save();
        this.applyTextTransforms();

        var lineWidth = current.lineWidth;
        var a1 = current.textMatrix[0], b1 = current.textMatrix[1];
        var scale = Math.sqrt(a1 * a1 + b1 * b1);
        if (scale === 0 || lineWidth === 0)
          lineWidth = this.getSinglePixelWidth();
        else
          lineWidth /= scale;

        if (textSelection)
          geom = this.createTextGeometry();

        if (fontSizeScale != 1.0) {
          ctx.scale(fontSizeScale, fontSizeScale);
          lineWidth /= fontSizeScale;
        }

        ctx.lineWidth = lineWidth;

        var x = 0;
        for (var i = 0; i < glyphsLength; ++i) {
          var glyph = glyphs[i];
          if (glyph === null) {
            // word break
            x += current.fontDirection * wordSpacing;
            continue;
          }

          var character = glyph.fontChar;
          var vmetric = glyph.vmetric || defaultVMetrics;
          if (vertical) {
            var vx = vmetric[1] * fontSize * current.fontMatrix[0];
            var vy = vmetric[2] * fontSize * current.fontMatrix[0];
          }
          var width = vmetric ? -vmetric[0] : glyph.width;
          var charWidth = width * fontSize * current.fontMatrix[0] +
                          charSpacing * current.fontDirection;
          var accent = glyph.accent;

          var scaledX, scaledY, scaledAccentX, scaledAccentY;
          if (!glyph.disabled) {
            if (vertical) {
              scaledX = vx / fontSizeScale;
              scaledY = (x + vy) / fontSizeScale;
            } else {
              scaledX = x / fontSizeScale;
              scaledY = 0;
            }
            if (accent) {
              scaledAccentX = scaledX + accent.offset.x / fontSizeScale;
              scaledAccentY = scaledY - accent.offset.y / fontSizeScale;
            }
            switch (textRenderingMode) {
              default: // other unsupported rendering modes
              case TextRenderingMode.FILL:
              case TextRenderingMode.FILL_ADD_TO_PATH:
                ctx.fillText(character, scaledX, scaledY);
                if (accent) {
                  ctx.fillText(accent.fontChar, scaledAccentX, scaledAccentY);
                }
                break;
              case TextRenderingMode.STROKE:
              case TextRenderingMode.STROKE_ADD_TO_PATH:
                ctx.strokeText(character, scaledX, scaledY);
                if (accent) {
                  ctx.strokeText(accent.fontChar, scaledAccentX, scaledAccentY);
                }
                break;
              case TextRenderingMode.FILL_STROKE:
              case TextRenderingMode.FILL_STROKE_ADD_TO_PATH:
                ctx.fillText(character, scaledX, scaledY);
                ctx.strokeText(character, scaledX, scaledY);
                if (accent) {
                  ctx.fillText(accent.fontChar, scaledAccentX, scaledAccentY);
                  ctx.strokeText(accent.fontChar, scaledAccentX, scaledAccentY);
                }
                break;
              case TextRenderingMode.INVISIBLE:
              case TextRenderingMode.ADD_TO_PATH:
                break;
            }
            if (textRenderingMode & TextRenderingMode.ADD_TO_PATH_FLAG) {
              var clipCtx = this.getCurrentTextClipping();
              clipCtx.fillText(character, scaledX, scaledY);
              if (accent) {
                clipCtx.fillText(accent.fontChar, scaledAccentX, scaledAccentY);
              }
            }
          }

          x += charWidth;

          canvasWidth += charWidth;
        }
        if (vertical) {
          current.y -= x * textHScale;
        } else {
          current.x += x * textHScale;
        }
        ctx.restore();
      }

      if (textSelection) {
        geom.canvasWidth = canvasWidth;
        if (vertical) {
          var vmetric = font.defaultVMetrics;
          geom.x -= vmetric[1] * fontSize * current.fontMatrix[0] /
                    fontSizeScale * geom.hScale;
          geom.y += vmetric[2] * fontSize * current.fontMatrix[0] /
                    fontSizeScale * geom.vScale;
        }
        this.textLayer.appendText(geom);
      }

      return canvasWidth;
    },
    showSpacedText: function(arr) {
      var ctx = this.ctx;
      var current = this.current;
      var font = current.font;
      var fontSize = current.fontSize;
      // TJ array's number is independent from fontMatrix
      var textHScale = current.textHScale * 0.001 * current.fontDirection;
      var arrLength = arr.length;
      var textLayer = this.textLayer;
      var geom;
      var canvasWidth = 0.0;
      var textSelection = textLayer ? true : false;
      var vertical = font.vertical;
      var spacingAccumulator = 0;

      if (textSelection) {
        ctx.save();
        this.applyTextTransforms();
        geom = this.createTextGeometry();
        ctx.restore();
      }

      for (var i = 0; i < arrLength; ++i) {
        var e = arr[i];
        if (isNum(e)) {
          var spacingLength = -e * fontSize * textHScale;
          if (vertical) {
            current.y += spacingLength;
          } else {
            current.x += spacingLength;
          }

          if (textSelection)
            spacingAccumulator += spacingLength;
        } else if (isString(e)) {
          var shownCanvasWidth = this.showText(e, true);

          if (textSelection) {
            canvasWidth += spacingAccumulator + shownCanvasWidth;
            spacingAccumulator = 0;
          }
        } else {
          error('TJ array element ' + e + ' is not string or num');
        }
      }

      if (textSelection) {
        geom.canvasWidth = canvasWidth;
        if (vertical) {
          var fontSizeScale = current.fontSizeScale;
          var vmetric = font.defaultVMetrics;
          geom.x -= vmetric[1] * fontSize * current.fontMatrix[0] /
                    fontSizeScale * geom.hScale;
          geom.y += vmetric[2] * fontSize * current.fontMatrix[0] /
                    fontSizeScale * geom.vScale;
        }
        this.textLayer.appendText(geom);
      }
    },
    nextLineShowText: function(text) {
      this.nextLine();
      this.showText(text);
    },
    nextLineSetSpacingShowText:
      function(wordSpacing,
                                                         charSpacing,
                                                         text) {
      this.setWordSpacing(wordSpacing);
      this.setCharSpacing(charSpacing);
      this.nextLineShowText(text);
    },

    // Type3 fonts
    setCharWidth: function(xWidth, yWidth) {
      // We can safely ignore this since the width should be the same
      // as the width in the Widths array.
    },
    setCharWidthAndBounds: function(xWidth,
                                                                        yWidth,
                                                                        llx,
                                                                        lly,
                                                                        urx,
                                                                        ury) {
      // TODO According to the spec we're also suppose to ignore any operators
      // that set color or include images while processing this type3 font.
      this.rectangle(llx, lly, urx - llx, ury - lly);
      this.clip();
      this.endPath();
    },

    // Color
    setStrokeColorSpace: function(raw) {
      this.current.strokeColorSpace = ColorSpace.fromIR(raw);
    },
    setFillColorSpace: function(raw) {
      this.current.fillColorSpace = ColorSpace.fromIR(raw);
    },
    setStrokeColor: function(/*...*/) {
      var cs = this.current.strokeColorSpace;
      var rgbColor = cs.getRgb(arguments, 0);
      var color = Util.makeCssRgb(rgbColor);
      this.ctx.strokeStyle = color;
      this.current.strokeColor = color;
    },
    getColorN_Pattern: function(IR, cs) {
      if (IR[0] == 'TilingPattern') {
        var args = IR[1];
        var base = cs.base;
        var color;
        if (base) {
          var baseComps = base.numComps;

          color = base.getRgb(args, 0);
        }
        var pattern = new TilingPattern(IR, color, this.ctx, this.objs,
                                        this.commonObjs);
      } else if (IR[0] == 'RadialAxial' || IR[0] == 'Dummy') {
        var pattern = Pattern.shadingFromIR(IR);
      } else {
        error('Unkown IR type ' + IR[0]);
      }
      return pattern;
    },
    setStrokeColorN: function(/*...*/) {
      var cs = this.current.strokeColorSpace;

      if (cs.name == 'Pattern') {
        this.current.strokeColor = this.getColorN_Pattern(arguments, cs);
      } else {
        this.setStrokeColor.apply(this, arguments);
      }
    },
    setFillColor: function(/*...*/) {
      var cs = this.current.fillColorSpace;
      var rgbColor = cs.getRgb(arguments, 0);
      var color = Util.makeCssRgb(rgbColor);
      this.ctx.fillStyle = color;
      this.current.fillColor = color;
    },
    setFillColorN: function(/*...*/) {
      var cs = this.current.fillColorSpace;

      if (cs.name == 'Pattern') {
        this.current.fillColor = this.getColorN_Pattern(arguments, cs);
      } else {
        this.setFillColor.apply(this, arguments);
      }
    },
    setStrokeGray: function(gray) {
      if (!(this.current.strokeColorSpace instanceof DeviceGrayCS))
        this.current.strokeColorSpace = new DeviceGrayCS();

      var rgbColor = this.current.strokeColorSpace.getRgb(arguments, 0);
      var color = Util.makeCssRgb(rgbColor);
      this.ctx.strokeStyle = color;
      this.current.strokeColor = color;
    },
    setFillGray: function(gray) {
      if (!(this.current.fillColorSpace instanceof DeviceGrayCS))
        this.current.fillColorSpace = new DeviceGrayCS();

      var rgbColor = this.current.fillColorSpace.getRgb(arguments, 0);
      var color = Util.makeCssRgb(rgbColor);
      this.ctx.fillStyle = color;
      this.current.fillColor = color;
    },
    setStrokeRGBColor: function(r, g, b) {
      if (!(this.current.strokeColorSpace instanceof DeviceRgbCS))
        this.current.strokeColorSpace = new DeviceRgbCS();

      var rgbColor = this.current.strokeColorSpace.getRgb(arguments, 0);
      var color = Util.makeCssRgb(rgbColor);
      this.ctx.strokeStyle = color;
      this.current.strokeColor = color;
    },
    setFillRGBColor: function(r, g, b) {
      if (!(this.current.fillColorSpace instanceof DeviceRgbCS))
        this.current.fillColorSpace = new DeviceRgbCS();

      var rgbColor = this.current.fillColorSpace.getRgb(arguments, 0);
      var color = Util.makeCssRgb(rgbColor);
      this.ctx.fillStyle = color;
      this.current.fillColor = color;
    },
    setStrokeCMYKColor: function(c, m, y, k) {
      if (!(this.current.strokeColorSpace instanceof DeviceCmykCS))
        this.current.strokeColorSpace = new DeviceCmykCS();

      var color = Util.makeCssCmyk(arguments);
      this.ctx.strokeStyle = color;
      this.current.strokeColor = color;
    },
    setFillCMYKColor: function(c, m, y, k) {
      if (!(this.current.fillColorSpace instanceof DeviceCmykCS))
        this.current.fillColorSpace = new DeviceCmykCS();

      var color = Util.makeCssCmyk(arguments);
      this.ctx.fillStyle = color;
      this.current.fillColor = color;
    },

    shadingFill: function(patternIR) {
      var ctx = this.ctx;

      this.save();
      var pattern = Pattern.shadingFromIR(patternIR);
      ctx.fillStyle = pattern.getPattern(ctx);

      var inv = ctx.mozCurrentTransformInverse;
      if (inv) {
        var canvas = ctx.canvas;
        var width = canvas.width;
        var height = canvas.height;

        var bl = Util.applyTransform([0, 0], inv);
        var br = Util.applyTransform([0, height], inv);
        var ul = Util.applyTransform([width, 0], inv);
        var ur = Util.applyTransform([width, height], inv);

        var x0 = Math.min(bl[0], br[0], ul[0], ur[0]);
        var y0 = Math.min(bl[1], br[1], ul[1], ur[1]);
        var x1 = Math.max(bl[0], br[0], ul[0], ur[0]);
        var y1 = Math.max(bl[1], br[1], ul[1], ur[1]);

        this.ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      } else {
        // HACK to draw the gradient onto an infinite rectangle.
        // PDF gradients are drawn across the entire image while
        // Canvas only allows gradients to be drawn in a rectangle
        // The following bug should allow us to remove this.
        // https://bugzilla.mozilla.org/show_bug.cgi?id=664884

        this.ctx.fillRect(-1e10, -1e10, 2e10, 2e10);
      }

      this.restore();
    },

    // Images
    beginInlineImage: function() {
      error('Should not call beginInlineImage');
    },
    beginImageData: function() {
      error('Should not call beginImageData');
    },

    paintFormXObjectBegin: function(matrix,
                                                                        bbox) {
      this.save();
      this.current.paintFormXObjectDepth++;

      if (matrix && isArray(matrix) && 6 == matrix.length)
        this.transform.apply(this, matrix);

      if (bbox && isArray(bbox) && 4 == bbox.length) {
        var width = bbox[2] - bbox[0];
        var height = bbox[3] - bbox[1];
        this.rectangle(bbox[0], bbox[1], width, height);
        this.clip();
        this.endPath();
      }
    },

    paintFormXObjectEnd: function() {
      var depth = this.current.paintFormXObjectDepth;
      do {
        this.restore();
        // some pdf don't close all restores inside object
        // closing those for them
      } while (this.current.paintFormXObjectDepth >= depth);
    },

    paintJpegXObject: function(objId, w, h) {
      var domImage = this.objs.get(objId);
      if (!domImage) {
        error('Dependent image isn\'t ready yet');
      }

      this.save();

      var ctx = this.ctx;
      // scale the image to the unit square
      ctx.scale(1 / w, -1 / h);

      ctx.drawImage(domImage, 0, 0, domImage.width, domImage.height,
                    0, -h, w, h);
      if (this.imageLayer) {
        var currentTransform = ctx.mozCurrentTransformInverse;
        var position = this.getCanvasPosition(0, 0);
        this.imageLayer.appendImage({
          objId: objId,
          left: position[0],
          top: position[1],
          width: w / currentTransform[0],
          height: h / currentTransform[3]
        });
      }
      this.restore();
    },

    paintImageMaskXObject: function(
                             imgArray, inverseDecode, width, height) {
      var ctx = this.ctx;
      var tmpCanvas = createScratchCanvas(width, height);
      var tmpCtx = tmpCanvas.getContext('2d');

      var fillColor = this.current.fillColor;
      tmpCtx.fillStyle = (fillColor && fillColor.hasOwnProperty('type') &&
                          fillColor.type === 'Pattern') ?
                          fillColor.getPattern(tmpCtx) : fillColor;
      tmpCtx.fillRect(0, 0, width, height);

      var imgData = tmpCtx.getImageData(0, 0, width, height);
      var pixels = imgData.data;

      applyStencilMask(imgArray, width, height, inverseDecode, pixels);

      this.paintInlineImageXObject(imgData);
    },

    paintImageMaskXObjectGroup:
      function(images) {
      var ctx = this.ctx;
      var tmpCanvasWidth = 0, tmpCanvasHeight = 0, tmpCanvas, tmpCtx;
      for (var i = 0, ii = images.length; i < ii; i++) {
        var image = images[i];
        var w = image.width, h = image.height;
        if (w > tmpCanvasWidth || h > tmpCanvasHeight) {
          tmpCanvasWidth = Math.max(w, tmpCanvasWidth);
          tmpCanvasHeight = Math.max(h, tmpCanvasHeight);
          tmpCanvas = createScratchCanvas(tmpCanvasWidth, tmpCanvasHeight);
          tmpCtx = tmpCanvas.getContext('2d');

          var fillColor = this.current.fillColor;
          tmpCtx.fillStyle = (fillColor && fillColor.hasOwnProperty('type') &&
                              fillColor.type === 'Pattern') ?
                              fillColor.getPattern(tmpCtx) : fillColor;
        }
        tmpCtx.fillRect(0, 0, w, h);

        var imgData = tmpCtx.getImageData(0, 0, w, h);
        var pixels = imgData.data;

        applyStencilMask(image.data, w, h, image.inverseDecode, pixels);

        tmpCtx.putImageData(imgData, 0, 0);

        ctx.save();
        ctx.transform.apply(ctx, image.transform);
        ctx.scale(1, -1);
        ctx.drawImage(tmpCanvas, 0, 0, w, h,
                      0, -1, 1, 1);
        ctx.restore();
      }
    },

    paintImageXObject: function(objId) {
      var imgData = this.objs.get(objId);
      if (!imgData)
        error('Dependent image isn\'t ready yet');

      this.paintInlineImageXObject(imgData);
    },

    paintInlineImageXObject:
      function(imgData) {
      var width = imgData.width;
      var height = imgData.height;
      var ctx = this.ctx;
      this.save();
      // scale the image to the unit square
      ctx.scale(1 / width, -1 / height);

      var currentTransform = ctx.mozCurrentTransformInverse;
      var widthScale = Math.max(Math.abs(currentTransform[0]), 1);
      var heightScale = Math.max(Math.abs(currentTransform[3]), 1);
      var tmpCanvas = createScratchCanvas(width, height);
      var tmpCtx = tmpCanvas.getContext('2d');

      if (widthScale > 2 || heightScale > 2) {
        // canvas does not resize well large images to small -- using simple
        // algorithm to perform pre-scaling
        tmpCanvas = prescaleImage(imgData.data,
                                 width, height,
                                 widthScale, heightScale);
        ctx.drawImage(tmpCanvas, 0, 0, tmpCanvas.width, tmpCanvas.height,
                                 0, -height, width, height);
      } else {
        if (typeof ImageData !== 'undefined' && imgData instanceof ImageData) {
          tmpCtx.putImageData(imgData, 0, 0);
        } else {
          putBinaryImageData(tmpCtx, imgData.data, width, height);
        }
        ctx.drawImage(tmpCanvas, 0, -height);
      }

      if (this.imageLayer) {
        var position = this.getCanvasPosition(0, -height);
        this.imageLayer.appendImage({
          imgData: imgData,
          left: position[0],
          top: position[1],
          width: width / currentTransform[0],
          height: height / currentTransform[3]
        });
      }
      this.restore();
    },

    paintInlineImageXObjectGroup:
      function(imgData, map) {
      var ctx = this.ctx;
      var w = imgData.width;
      var h = imgData.height;

      var tmpCanvas = createScratchCanvas(w, h);
      var tmpCtx = tmpCanvas.getContext('2d');
      putBinaryImageData(tmpCtx, imgData.data, w, h);

      for (var i = 0, ii = map.length; i < ii; i++) {
        var entry = map[i];
        ctx.save();
        ctx.transform.apply(ctx, entry.transform);
        ctx.scale(1, -1);
        ctx.drawImage(tmpCanvas, entry.x, entry.y, entry.w, entry.h,
                      0, -1, 1, 1);
        if (this.imageLayer) {
          var position = this.getCanvasPosition(entry.x, entry.y);
          this.imageLayer.appendImage({
            imgData: imgData,
            left: position[0],
            top: position[1],
            width: w,
            height: h
          });
        }
        ctx.restore();
      }
    },

    // Marked content

    markPoint: function(tag) {
      // TODO Marked content.
    },
    markPointProps: function(tag, properties) {
      // TODO Marked content.
    },
    beginMarkedContent: function(tag) {
      // TODO Marked content.
    },
    beginMarkedContentProps: function(
                                        tag, properties) {
      // TODO Marked content.
    },
    endMarkedContent: function() {
      // TODO Marked content.
    },

    // Compatibility

    beginCompat: function() {
      // TODO ignore undefined operators (should we do that anyway?)
    },
    endCompat: function() {
      // TODO stop ignoring undefined operators
    },

    // Helper functions

    consumePath: function() {
      if (this.pendingClip) {
        var savedFillRule = null;
        if (this.pendingClip == EO_CLIP)
          savedFillRule = this.setEOFillRule();

        this.ctx.clip();

        this.pendingClip = null;
        if (savedFillRule !== null)
          this.restoreFillRule(savedFillRule);
      }
      this.ctx.beginPath();
    },
    // We generally keep the canvas context set for
    // nonzero-winding, and just set evenodd for the operations
    // that need them.
    setEOFillRule: function() {
      var savedFillRule = this.ctx.mozFillRule;
      this.ctx.mozFillRule = 'evenodd';
      return savedFillRule;
    },
    restoreFillRule: function(rule) {
      this.ctx.mozFillRule = rule;
    },
    getSinglePixelWidth: function(scale) {
      var inverse = this.ctx.mozCurrentTransformInverse;
      // max of the current horizontal and vertical scale
      return Math.sqrt(Math.max(
        (inverse[0] * inverse[0] + inverse[1] * inverse[1]),
        (inverse[2] * inverse[2] + inverse[3] * inverse[3])));
    },
    getCanvasPosition: function(x, y) {
        var transform = this.ctx.mozCurrentTransform;
        return [
          transform[0] * x + transform[2] * y + transform[4],
          transform[1] * x + transform[3] * y + transform[5]
        ];
    }
  };

  return CanvasGraphics;
})();

