document.addEventListener('DOMContentLoaded', function() {

  // DOM elements

  const fileUpload = document.getElementById('fileUpload');
  const gridSize = document.getElementById('gridSize');
  const brightness = document.getElementById('brightness');
  const contrast = document.getElementById('contrast');
  const gamma = document.getElementById('gamma');
  const smoothing = document.getElementById('smoothing');
  const ditherType = document.getElementById('ditherType');
  const resetButton = document.getElementById('resetButton');
  const saveButton = document.getElementById('saveButton');
  const saveVideoButton = document.getElementById('saveVideoButton');

  const gridSizeVal = document.getElementById('gridSizeVal');
  const brightnessVal = document.getElementById('brightnessVal');
  const contrastVal = document.getElementById('contrastVal');
  const gammaVal = document.getElementById('gammaVal');
  const smoothingVal = document.getElementById('smoothingVal');

  const halftoneCanvas = document.getElementById('halftoneCanvas');

  // New customization options
  const multicolorCheckbox = document.getElementById('multicolor');
  const dotColorPicker = document.getElementById('dotColor');
  const backgroundColorPicker = document.getElementById('backgroundColor');



  // Global variables for preview
  let imageElement = null;
  let videoElement = null;
  let isVideo = false;
  let animationFrameId;

  // Default parameter values
  const defaults = {
    gridSize: 20,
    brightness: 20,
    contrast: 0,
    gamma: 1.0,
    smoothing: 0,
    ditherType: "None",
    dotColor: '#000000', // Default dot color is black
    backgroundColor: '#FFFFFF', // Default background color is white
    multicolor: false,
  };

  // Debounce helper to limit update frequency.
  function debounce(func, wait) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  function updateAndProcess() {
    gridSizeVal.textContent = gridSize.value;
    brightnessVal.textContent = brightness.value;
    contrastVal.textContent = contrast.value;
    gammaVal.textContent = gamma.value;
    smoothingVal.textContent = smoothing.value;
    if (imageElement || videoElement) {
      processFrame();
    }
  }

  const debouncedUpdate = debounce(updateAndProcess, 150);

  // Attach listeners to controls.
  gridSize.addEventListener('input', debouncedUpdate);
  brightness.addEventListener('input', debouncedUpdate);
  contrast.addEventListener('input', debouncedUpdate);
  gamma.addEventListener('input', debouncedUpdate);
  smoothing.addEventListener('input', debouncedUpdate);
  ditherType.addEventListener('change', debouncedUpdate);

  // Attach listeners to new customization options
  multicolorCheckbox.addEventListener('change', function() {
    defaults.multicolor = this.checked;
    dotColorPicker.disabled = this.checked; // Disable dot color picker when multicolor is selected
    updateAndProcess();
  });
  dotColorPicker.addEventListener('change', function() {
    defaults.dotColor = this.value;
    updateAndProcess();
  });
  backgroundColorPicker.addEventListener('change', function() {
    defaults.backgroundColor = this.value;
    updateAndProcess();
  });

  fileUpload.addEventListener('change', handleFileUpload);

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileURL = URL.createObjectURL(file);
    if (file.type.startsWith('video/')) {
      isVideo = true;
      if (videoElement) {
        videoElement.src = fileURL;
      } else {
        videoElement = document.createElement('video');
        videoElement.crossOrigin = "anonymous";
        videoElement.src = fileURL;
        videoElement.autoplay = true;
        videoElement.loop = true;
        videoElement.muted = true;
        videoElement.playsInline = true;
        videoElement.setAttribute("webkit-playsinline", "true");
        videoElement.addEventListener('loadeddata', () => {
          setupCanvasDimensions(videoElement.videoWidth, videoElement.videoHeight);
          videoElement.play();
          processVideoFrame();
        });
        videoElement.addEventListener('error', (e) => {
          console.error("Error loading video:", e);
        });
      }
    } else if (file.type.startsWith('image/')) {
      isVideo = false;
      if (videoElement) {
        cancelAnimationFrame(animationFrameId);
        videoElement.pause();
      }
      imageElement = new Image();
      imageElement.src = fileURL;
      imageElement.addEventListener('load', () => {
        setupCanvasDimensions(imageElement.width, imageElement.height);
        processFrame();
      });
    }
  }

function setupCanvasDimensions(width, height) {
  const minHeight = 1080;
  let newWidth = width;
  let newHeight = height;

  if (height < minHeight) {
    const scaleFactor = minHeight / height;
    newHeight = minHeight;
    newWidth = Math.round(width * scaleFactor);
  }

  halftoneCanvas.width = newWidth;
  halftoneCanvas.height = newHeight;
}

  function processFrame() {
    if (!imageElement && !videoElement) return;
    generateHalftone(halftoneCanvas, 1);
  }

  function processVideoFrame() {
    if (!isVideo) return;
    processFrame();
    animationFrameId = requestAnimationFrame(processVideoFrame);
  }

let cellValues; // Add this line to declare the variable outside the function

  // Generate halftone: compute grayscale per grid cell by iterating over full-resolution data.
function generateHalftone(targetCanvas, scaleFactor, isExport = false) {
  const previewWidth = halftoneCanvas.width;
  const previewHeight = halftoneCanvas.height;
  const targetWidth = isExport ? Math.max(previewWidth * scaleFactor, 1920) : previewWidth * scaleFactor;
  const targetHeight = isExport ? Math.max(previewHeight * scaleFactor, 1080) : previewHeight * scaleFactor;

  targetCanvas.width = targetWidth;
  targetCanvas.height = targetHeight;

  // Draw the full-resolution image/video onto a temporary canvas.
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = targetWidth;
  tempCanvas.height = targetHeight;
  const tempCtx = tempCanvas.getContext('2d');

  if (isVideo) {
    tempCtx.drawImage(videoElement, 0, 0, targetWidth, targetHeight);
  } else {
    tempCtx.drawImage(imageElement, 0, 0, targetWidth, targetHeight);
  }

  const imgData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imgData.data;

  const brightnessAdj = parseInt(brightness.value, 10);
  const contrastAdj = parseInt(contrast.value, 10);
  const gammaValNum = parseFloat(gamma.value);
  const contrastFactor = (259 * (contrastAdj + 255)) / (255 * (259 - contrastAdj));

  // Compute grayscale value per pixel.
  const grayData = new Float32Array(targetWidth * targetHeight);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    gray = contrastFactor * (gray - 128) + 128 + brightnessAdj;
    gray = Math.max(0, Math.min(255, gray));
    gray = 255 * Math.pow(gray / 255, 1 / gammaValNum);
    grayData[i / 4] = gray;
  }

  // Divide the image into grid cells.
  const grid = parseInt(gridSize.value, 10) * scaleFactor;
  const numCols = Math.ceil(targetWidth / grid);
  const numRows = Math.ceil(targetHeight / grid);
  cellValues = new Float32Array(numRows * numCols); // Update this line to store cellValues globally

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      let sum = 0, count = 0;
      const startY = row * grid;
      const startX = col * grid;
      const endY = Math.min(startY + grid, targetHeight);
      const endX = Math.min(startX + grid, targetWidth);
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          sum += grayData[y * targetWidth + x];
          count++;
        }
      }
      cellValues[row * numCols + col] = sum / count;
    }
  }

  // Apply smoothing if enabled.
  const smoothingStrength = parseFloat(smoothing.value);
  if (smoothingStrength > 0) {
    cellValues = applyBoxBlur(cellValues, numRows, numCols, smoothingStrength);
  }

  // Apply dithering if selected.
  const selectedDither = ditherType.value;
  if (selectedDither === "FloydSteinberg") {
    applyFloydSteinbergDithering(cellValues, numRows, numCols);
  } else if (selectedDither === "JarvisJudiceNinke") {
    applyJarvisJudiceNinkeDithering(cellValues, numRows, numCols);
  } else if (selectedDither === "Stucki") {
    applyStuckiDithering(cellValues, numRows, numCols);
  } else if (selectedDither === "Burkes") {
    applyBurkesDithering(cellValues, numRows, numCols);
  } else if (selectedDither === "Ordered") {
    applyOrderedDithering(cellValues, numRows, numCols);
  } else if (selectedDither === "Noise") {
    applyNoiseDithering(cellValues, numRows, numCols);
  }

  // Draw the halftone dots.
  const ctx = targetCanvas.getContext('2d');
  ctx.fillStyle = defaults.backgroundColor; // Set background color
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const brightnessValue = cellValues[row * numCols + col];
      const norm = brightnessValue / 255;
      const maxRadius = grid / 2;
      const radius = maxRadius * (1 - norm);
      if (radius > 0.5) {
        ctx.beginPath();
        const centerX = col * grid + grid / 2;
        const centerY = row * grid + grid / 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = getDotColor(brightnessValue);
        ctx.fill();
      }
    }
  }
}

  function getDotColor(brightnessValue) {
    if (defaults.multicolor) {
      const hue = (brightnessValue / 255) * 360;
      return `hsl(${hue}, 100%, 50%)`;
    } else {
      return defaults.dotColor; // Use the selected dot color
    }
  }

  // 3× Box Blur for smoothing grid cell values.
  function applyBoxBlur(cellValues, numRows, numCols, strength) {
    let result = new Float32Array(cellValues);
    const passes = Math.floor(strength);
    for (let p = 0; p < passes; p++) {
      let temp = new Float32Array(result.length);
      for (let row = 0; row < numRows; row++) {
        for (let col = 0; col < numCols; col++) {
          let sum = 0, count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const r = row + dy, c = col + dx;
              if (r >= 0 && r < numRows && c >= 0 && c < numCols) {
                sum += result[r * numCols + c];
                count++;
              }
            }
          }
          temp[row * numCols + col] = sum / count;
        }
      }
      result = temp;
    }
    const frac = strength - Math.floor(strength);
    if (frac > 0) {
      for (let i = 0; i < result.length; i++) {
        result[i] = cellValues[i] * (1 - frac) + result[i] * frac;
      }
    }
    return result;
  }

  function applyFloydSteinbergDithering(cellValues, numRows, numCols) {
    const threshold = 128;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const index = row * numCols + col;
        const oldVal = cellValues[index];
        const newVal = oldVal < threshold ? 0 : 255;
        const error = oldVal - newVal;
        cellValues[index] = newVal;
        if (col + 1 < numCols) {
          cellValues[row * numCols + (col + 1)] += error * (7 / 16);
        }
        if (row + 1 < numRows) {
          if (col - 1 >= 0) {
            cellValues[(row + 1) * numCols + (col - 1)] += error * (3 / 16);
          }
          cellValues[(row + 1) * numCols + col] += error * (5 / 16);
          if (col + 1 < numCols) {
            cellValues[(row + 1) * numCols + (col + 1)] += error * (1 / 16);
          }
        }
      }
    }
  }

function applyJarvisJudiceNinkeDithering(cellValues, numRows, numCols) {
  const threshold = 128;
  const diffusionMatrix = [
    [0, 0, 0, 7 / 48, 5 / 48],
    [3 / 48, 5 / 48, 7 / 48, 5 / 48, 3 / 48],
    [1 / 48, 3 / 48, 5 / 48, 3 / 48, 1 / 48]
  ];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const index = row * numCols + col;
      const oldVal = cellValues[index];
      const newVal = oldVal < threshold ? 0 : 255;
      const error = oldVal - newVal;
      cellValues[index] = newVal;
      for (let i = 0; i < diffusionMatrix.length; i++) {
        for (let j = 0; j < diffusionMatrix[i].length; j++) {
          if (diffusionMatrix[i][j] !== 0) {
            const x = col + j - 2;
            const y = row + i;
            if (x >= 0 && x < numCols && y < numRows) {
              cellValues[y * numCols + x] += error * diffusionMatrix[i][j];
            }
          }
        }
      }
    }
  }
}

function applyStuckiDithering(cellValues, numRows, numCols) {
  const threshold = 128;
  const diffusionMatrix = [
    [0, 0, 0, 8 / 42, 4 / 42],
    [2 / 42, 4 / 42, 8 / 42, 4 / 42, 2 / 42],
    [1 / 42, 2 / 42, 4 / 42, 2 / 42, 1 / 42]
  ];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const index = row * numCols + col;
      const oldVal = cellValues[index];
      const newVal = oldVal < threshold ? 0 : 255;
      const error = oldVal - newVal;
      cellValues[index] = newVal;
      for (let i = 0; i < diffusionMatrix.length; i++) {
        for (let j = 0; j < diffusionMatrix[i].length; j++) {
          if (diffusionMatrix[i][j] !== 0) {
            const x = col + j - 2;
            const y = row + i;
            if (x >= 0 && x < numCols && y < numRows) {
              cellValues[y * numCols + x] += error * diffusionMatrix[i][j];
            }
          }
        }
      }
    }
  }
}

function applyBurkesDithering(cellValues, numRows, numCols) {
  const threshold = 128;
  const diffusionMatrix = [
    [0, 0, 0, 8 / 32, 4 / 32],
    [2 / 32, 4 / 32, 8 / 32, 4 / 32, 2 / 32]
  ];
  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const index = row * numCols + col;
      const oldVal = cellValues[index];
      const newVal = oldVal < threshold ? 0 : 255;
      const error = oldVal - newVal;
      cellValues[index] = newVal;
      for (let i = 0; i < diffusionMatrix.length; i++) {
        for (let j = 0; j < diffusionMatrix[i].length; j++) {
          if (diffusionMatrix[i][j] !== 0) {
            const x = col + j - 2;
            const y = row + i;
            if (x >= 0 && x < numCols && y < numRows) {
              cellValues[y * numCols + x] += error * diffusionMatrix[i][j];
            }
          }
        }
      }
    }
  }
}

  function applyOrderedDithering(cellValues, numRows, numCols) {
    const bayerMatrix = [[0,2],[3,1]];
    const matrixSize = 2;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const index = row * numCols + col;
        const threshold = ((bayerMatrix[row % matrixSize][col % matrixSize] + 0.5) *
                           (255 / (matrixSize * matrixSize)));
        cellValues[index] = cellValues[index] < threshold ? 0 : 255;
      }
    }
  }

  function applyNoiseDithering(cellValues, numRows, numCols) {
    const threshold = 128;
    for (let row = 0; row < numRows; row++) {
      for (let col = 0; col < numCols; col++) {
        const index = row * numCols + col;
        const noise = (Math.random() - 0.5) * 50;
        const adjustedVal = cellValues[index] + noise;
        cellValues[index] = adjustedVal < threshold ? 0 : 255;
      }
    }
  }

// Add this function to generate the SVG data
function generateSVG(scaleFactor, isExport = false) {
  const previewWidth = halftoneCanvas.width;
  const previewHeight = halftoneCanvas.height;
  const targetWidth = isExport ? Math.max(previewWidth * scaleFactor, 1920) : previewWidth * scaleFactor;
  const targetHeight = isExport ? Math.max(previewHeight * scaleFactor, 1080) : previewHeight * scaleFactor;

  let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${targetWidth}" height="${targetHeight}" viewBox="0 0 ${targetWidth} ${targetHeight}">`;
  svgContent += `<rect width="100%" height="100%" fill="${defaults.backgroundColor}"/>`;

  const grid = parseInt(gridSize.value, 10) * scaleFactor;
  const numCols = Math.ceil(targetWidth / grid);
  const numRows = Math.ceil(targetHeight / grid);

  for (let row = 0; row < numRows; row++) {
    for (let col = 0; col < numCols; col++) {
      const brightnessValue = cellValues[row * numCols + col];
      const norm = brightnessValue / 255;
      const maxRadius = grid / 2;
      const radius = maxRadius * (1 - norm);
      if (radius > 0.5) {
        const centerX = col * grid + grid / 2;
        const centerY = row * grid + grid / 2;
        const color = getDotColor(brightnessValue);
        svgContent += `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="${color}"/>`;
      }
    }
  }

  svgContent += `</svg>`;
  return svgContent;
}

// Add this event listener for the SVG export button
saveSVGButton.addEventListener('click', () => {
  if (!imageElement && !videoElement) return;
  const svgData = generateSVG(2, true); // Pass true for isExport
  const blob = new Blob([svgData], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `halftone_${Math.floor(Math.random() * 100000)}.svg`;
  link.click();
  URL.revokeObjectURL(url);
});

  resetButton.addEventListener('click', () => {
    gridSize.value = defaults.gridSize;
    brightness.value = defaults.brightness;
    contrast.value = defaults.contrast;
    gamma.value = defaults.gamma;
    smoothing.value = defaults.smoothing;
    ditherType.value = defaults.ditherType;
    multicolorCheckbox.checked = defaults.multicolor;
    dotColorPicker.value = defaults.dotColor;
    backgroundColorPicker.value = defaults.backgroundColor;
    dotColorPicker.disabled = defaults.multicolor;
    updateAndProcess();
  });

  saveButton.addEventListener('click', () => {
    if (!imageElement && !videoElement) return;
    const exportCanvas = document.createElement('canvas');
    generateHalftone(exportCanvas, 2, true); // Pass true for isExport
    const dataURL = exportCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = dataURL;
    link.download = `halftone_${Math.floor(Math.random() * 100000)}.png`;
    link.click();
  });

  let mediaRecorder;
  let recordedChunks = [];
  let isRecording = false;

  function generateRandomFilename(extension) {
    return `halftone_${Math.floor(Math.random() * 100000)}.${extension}`;
  }

  // Add a "Stop Recording" button dynamically
  const stopRecordingButton = document.createElement('button');
  stopRecordingButton.id = 'stopRecordingButton';
  stopRecordingButton.textContent = 'Stop Recording';
  stopRecordingButton.className = 'btn btn-primary';
  stopRecordingButton.style.display = 'none'; // Initially hidden
  document.querySelector('.action-panel').appendChild(stopRecordingButton);

  saveVideoButton.addEventListener('click', function() {
    if (!isVideo) return;

    // Start recording
    recordedChunks = [];
    setupCanvasDimensions(videoElement.videoWidth, videoElement.videoHeight, true); // Pass true for isExport

    // Capture the canvas stream at 30fps
    let stream = halftoneCanvas.captureStream(30);

    // Set up the MediaRecorder with the correct MIME type
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'video/webm; codecs=vp9', // Use VP9 for better quality
      videoBitsPerSecond: 5000000 // Increase bitrate for better quality
    });

    // Handle data available event
    mediaRecorder.ondataavailable = function(event) {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    // Handle recording stop event
    mediaRecorder.onstop = function() {
      // Create a blob from the recorded chunks
      const blob = new Blob(recordedChunks, { type: 'video/webm' });

      // Create a URL for the blob
      const url = URL.createObjectURL(blob);

      // Create a download link
      const a = document.createElement('a');
      a.href = url;
      a.download = generateRandomFilename('webm'); // Set the filename
      document.body.appendChild(a);
      a.click(); // Trigger the download

      // Clean up the URL object
      setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }, 100);

      // Reset UI
      saveVideoButton.style.display = 'inline-block';
      stopRecordingButton.style.display = 'none';
      isRecording = false;
    };

    // Start recording
    mediaRecorder.start();
    isRecording = true;

    // Update UI
    saveVideoButton.style.display = 'none';
    stopRecordingButton.style.display = 'inline-block';
  });

  stopRecordingButton.addEventListener('click', function() {
    if (isRecording) {
      mediaRecorder.stop(); // Stop the recording
    }
  });

  // Automatically load the default video.
  (function loadDefaultVideo() {
    const videoURL = "./webgl/assets/horse.mp4"; // Muybridge horse (was https://i.imgur.com/5PrJCc2.mp4)
    isVideo = true;
    videoElement = document.createElement('video');
    videoElement.crossOrigin = "anonymous";
    videoElement.playsInline = true;
    videoElement.setAttribute("webkit-playsinline", "true");
    videoElement.src = videoURL;
    videoElement.autoplay = true;
    videoElement.loop = true;
    videoElement.muted = true;
    videoElement.addEventListener('loadeddata', () => {
      setupCanvasDimensions(videoElement.videoWidth, videoElement.videoHeight);
      videoElement.play();
      processVideoFrame();
    });
    videoElement.addEventListener('error', (e) => {
      console.error("Error loading default video:", e);
    });
  })();
});
