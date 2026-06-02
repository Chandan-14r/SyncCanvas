import { showToast } from './app.js';
import * as Y from 'yjs';

let activeTool = 'select'; // select, pencil, rect, circle, line
let strokeColor = '#3b82f6';
let strokeWidth = 2;

let yshapes = null;
let ydocRef = null;
let activeProvider = null;
let currentRoom = null;

let selectedShapeId = null;
let isDrawing = false;
let isDragging = false;
let currentShapeId = null;

let startX = 0;
let startY = 0;
let dragStartX = 0;
let dragStartY = 0;
let dragStartShapeData = null;

/**
 * Initializes the Collaborative SVG Whiteboard.
 * 
 * @param {object} provider - The y-websocket provider instance
 * @param {object} ydoc - The shared Y.Doc document
 * @param {string} docId - The active room/document ID
 */
export function initWhiteboard(provider, ydoc, docId) {
  const canvas = document.getElementById('whiteboard-canvas');
  if (!canvas) return;

  ydocRef = ydoc;
  activeProvider = provider;
  currentRoom = docId;

  // Initialize Yjs Shared Shape Map
  yshapes = ydoc.getMap('whiteboard_shapes');

  // Bind Toolbar Buttons & Controls
  setupToolbar();

  // Bind Mouse & Touch events
  setupMouseEvents(canvas);

  // Sync initial shapes and observe changes
  setupShapeObserver(canvas);

  // Sync awareness pointers
  setupPointerSync(provider);

  // Bind Key Events (Delete/Backspace to delete selected shape)
  setupKeyEvents();
}

/**
 * Setup toolbar controls, color pickers, and tool switchers.
 */
function setupToolbar() {
  const tools = {
    'wb-tool-select': 'select',
    'wb-tool-pencil': 'pencil',
    'wb-tool-rect': 'rect',
    'wb-tool-circle': 'circle',
    'wb-tool-line': 'line'
  };

  const toolButtons = {};
  
  // Set up active states
  Object.keys(tools).forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    toolButtons[tools[btnId]] = btn;

    btn.addEventListener('click', () => {
      // Toggle active states
      Object.keys(toolButtons).forEach(t => toolButtons[t].classList.remove('active'));
      btn.classList.add('active');
      activeTool = tools[btnId];
      
      // Clear selection when changing tool
      if (activeTool !== 'select') {
        setSelectedShape(null);
      }
    });
  });

  // Color Selector
  const colorInput = document.getElementById('wb-stroke-color');
  if (colorInput) {
    colorInput.value = strokeColor;
    colorInput.addEventListener('change', (e) => {
      strokeColor = e.target.value;
      if (selectedShapeId && yshapes.has(selectedShapeId)) {
        // Update stroke of selected shape
        const shape = yshapes.get(selectedShapeId);
        shape.stroke = strokeColor;
        yshapes.set(selectedShapeId, shape);
      }
    });
  }

  // Width Selector
  const widthSelect = document.getElementById('wb-stroke-width');
  if (widthSelect) {
    widthSelect.value = strokeWidth;
    widthSelect.addEventListener('change', (e) => {
      strokeWidth = parseInt(e.target.value, 10);
      if (selectedShapeId && yshapes.has(selectedShapeId)) {
        // Update stroke-width of selected shape
        const shape = yshapes.get(selectedShapeId);
        shape.strokeWidth = strokeWidth;
        yshapes.set(selectedShapeId, shape);
      }
    });
  }

  // Delete Selected Button
  const deleteBtn = document.getElementById('wb-btn-delete');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', deleteSelectedShape);
  }

  // Clear Canvas Button
  const clearBtn = document.getElementById('wb-btn-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear the entire whiteboard? This cannot be undone.')) {
        ydocRef.transact(() => {
          yshapes.clear();
        });
        setSelectedShape(null);
        showToast('Whiteboard cleared!', 'info', 2000);
      }
    });
  }
}

/**
 * Handle mouse drawing and shape selection logic.
 */
function setupMouseEvents(canvas) {
  canvas.addEventListener('mousedown', (e) => {
    // Get mouse coordinates relative to SVG canvas bounding client rect
    const rect = canvas.getBoundingClientRect();
    const mouseX = Math.round(e.clientX - rect.left);
    const mouseY = Math.round(e.clientY - rect.top);

    startX = mouseX;
    startY = mouseY;

    if (activeTool === 'select') {
      // Find if we clicked on an SVG shape element
      const targetElement = e.target.closest('.wb-shape-element');
      if (targetElement) {
        const shapeId = targetElement.dataset.id;
        setSelectedShape(shapeId);
        
        isDragging = true;
        dragStartX = mouseX;
        dragStartY = mouseY;
        
        // Deep copy starting position of target shape
        const shapeData = yshapes.get(shapeId);
        dragStartShapeData = JSON.parse(JSON.stringify(shapeData));
      } else {
        setSelectedShape(null);
      }
    } else {
      // Drawing a new shape
      isDrawing = true;
      const shapeId = 'shape-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
      currentShapeId = shapeId;

      let shapeData = {
        id: shapeId,
        type: activeTool,
        stroke: strokeColor,
        strokeWidth: strokeWidth
      };

      if (activeTool === 'rect') {
        Object.assign(shapeData, { x: startX, y: startY, width: 0, height: 0, fill: 'transparent' });
      } else if (activeTool === 'circle') {
        Object.assign(shapeData, { cx: startX, cy: startY, r: 0, fill: 'transparent' });
      } else if (activeTool === 'line') {
        Object.assign(shapeData, { x1: startX, y1: startY, x2: startX, y2: startY });
      } else if (activeTool === 'pencil') {
        Object.assign(shapeData, { points: [{ x: startX, y: startY }] });
      }

      ydocRef.transact(() => {
        yshapes.set(shapeId, shapeData);
      });
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = Math.round(e.clientX - rect.left);
    const mouseY = Math.round(e.clientY - rect.top);

    // 1. Handle Drawing shape resizing
    if (isDrawing && currentShapeId && yshapes.has(currentShapeId)) {
      const shape = yshapes.get(currentShapeId);
      
      ydocRef.transact(() => {
        if (shape.type === 'rect') {
          shape.x = Math.min(startX, mouseX);
          shape.y = Math.min(startY, mouseY);
          shape.width = Math.abs(startX - mouseX);
          shape.height = Math.abs(startY - mouseY);
        } else if (shape.type === 'circle') {
          shape.r = Math.round(Math.sqrt(Math.pow(startX - mouseX, 2) + Math.pow(startY - mouseY, 2)));
        } else if (shape.type === 'line') {
          shape.x2 = mouseX;
          shape.y2 = mouseY;
        } else if (shape.type === 'pencil') {
          shape.points.push({ x: mouseX, y: mouseY });
        }
        yshapes.set(currentShapeId, shape);
      });
    }

    // 2. Handle Dragging existing shape
    if (isDragging && selectedShapeId && yshapes.has(selectedShapeId) && dragStartShapeData) {
      const shape = yshapes.get(selectedShapeId);
      const dx = mouseX - dragStartX;
      const dy = mouseY - dragStartY;

      ydocRef.transact(() => {
        if (shape.type === 'rect') {
          shape.x = dragStartShapeData.x + dx;
          shape.y = dragStartShapeData.y + dy;
        } else if (shape.type === 'circle') {
          shape.cx = dragStartShapeData.cx + dx;
          shape.cy = dragStartShapeData.cy + dy;
        } else if (shape.type === 'line') {
          shape.x1 = dragStartShapeData.x1 + dx;
          shape.y1 = dragStartShapeData.y1 + dy;
          shape.x2 = dragStartShapeData.x2 + dx;
          shape.y2 = dragStartShapeData.y2 + dy;
        } else if (shape.type === 'pencil') {
          shape.points = dragStartShapeData.points.map(p => ({
            x: p.x + dx,
            y: p.y + dy
          }));
        }
        yshapes.set(selectedShapeId, shape);
      });
    }

    // 3. Broadcast mouse cursor to collaborators
    if (activeProvider && activeProvider.awareness) {
      const localState = activeProvider.awareness.getLocalState();
      activeProvider.awareness.setLocalStateField('canvasPointer', {
        x: mouseX,
        y: mouseY,
        room: currentRoom
      });
    }
  });

  const finishDrawingOrDragging = () => {
    isDrawing = false;
    isDragging = false;
    currentShapeId = null;
    dragStartShapeData = null;
  };

  canvas.addEventListener('mouseup', finishDrawingOrDragging);
  canvas.addEventListener('mouseleave', () => {
    finishDrawingOrDragging();
    // Remove local canvas cursor upon leaving SVG boundaries
    if (activeProvider && activeProvider.awareness) {
      activeProvider.awareness.setLocalStateField('canvasPointer', null);
    }
  });
}

/**
 * Watch for changes in yshapes Map and dynamically maintain corresponding DOM nodes.
 */
function setupShapeObserver(canvas) {
  const shapesGroup = document.getElementById('wb-shapes-group');
  if (!shapesGroup) return;

  // Render pre-existing shapes on load
  yshapes.forEach((shape, id) => {
    updateOrCreateShapeDOM(shapesGroup, shape, id);
  });

  // Watch for granular add, update, delete events
  yshapes.observe(event => {
    event.changes.keys.forEach((change, id) => {
      if (change.action === 'add' || change.action === 'update') {
        const shape = yshapes.get(id);
        if (shape) {
          updateOrCreateShapeDOM(shapesGroup, shape, id);
        }
      } else if (change.action === 'delete') {
        const domEl = document.getElementById(`wb-shape-${id}`);
        if (domEl) {
          domEl.parentNode.removeChild(domEl);
        }
        if (selectedShapeId === id) {
          setSelectedShape(null);
        }
      }
    });
  });
}

/**
 * Creates a shape DOM element or updates its attributes.
 */
function updateOrCreateShapeDOM(parentGroup, shape, id) {
  let element = document.getElementById(`wb-shape-${id}`);
  const isSelected = selectedShapeId === id;

  if (!element) {
    // Create new element depending on shape type
    let tagName = 'rect';
    if (shape.type === 'circle') tagName = 'circle';
    else if (shape.type === 'line') tagName = 'line';
    else if (shape.type === 'pencil') tagName = 'path';

    element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
    element.id = `wb-shape-${id}`;
    element.setAttribute('class', 'wb-shape-element');
    element.dataset.id = id;
    parentGroup.appendChild(element);
  }

  // Update SVG styling attributes
  element.setAttribute('stroke', shape.stroke);
  element.setAttribute('stroke-width', shape.strokeWidth);
  
  if (shape.type === 'rect') {
    element.setAttribute('x', shape.x);
    element.setAttribute('y', shape.y);
    element.setAttribute('width', shape.width);
    element.setAttribute('height', shape.height);
    element.setAttribute('fill', shape.fill || 'transparent');
  } else if (shape.type === 'circle') {
    element.setAttribute('cx', shape.cx);
    element.setAttribute('cy', shape.cy);
    element.setAttribute('r', shape.r);
    element.setAttribute('fill', shape.fill || 'transparent');
  } else if (shape.type === 'line') {
    element.setAttribute('x1', shape.x1);
    element.setAttribute('y1', shape.y1);
    element.setAttribute('x2', shape.x2);
    element.setAttribute('y2', shape.y2);
  } else if (shape.type === 'pencil') {
    element.setAttribute('fill', 'none');
    if (shape.points && shape.points.length > 0) {
      const pathData = shape.points.map((p, i) => 
        i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`
      ).join(' ');
      element.setAttribute('d', pathData);
    }
  }

  // Toggle selection outline style
  if (isSelected) {
    element.classList.add('selected');
  } else {
    element.classList.remove('selected');
  }
}

/**
 * Highlight / select shape inside local UI memory.
 */
function setSelectedShape(shapeId) {
  const shapesGroup = document.getElementById('wb-shapes-group');
  const deleteBtn = document.getElementById('wb-btn-delete');

  if (selectedShapeId && selectedShapeId !== shapeId) {
    const oldSelection = document.getElementById(`wb-shape-${selectedShapeId}`);
    if (oldSelection) oldSelection.classList.remove('selected');
  }

  selectedShapeId = shapeId;

  if (selectedShapeId) {
    const newSelection = document.getElementById(`wb-shape-${selectedShapeId}`);
    if (newSelection) newSelection.classList.add('selected');
    if (deleteBtn) deleteBtn.removeAttribute('disabled');

    // Load selected shape's color/width back into the toolbar controls
    if (yshapes && yshapes.has(selectedShapeId)) {
      const shape = yshapes.get(selectedShapeId);
      const colorInput = document.getElementById('wb-stroke-color');
      const widthSelect = document.getElementById('wb-stroke-width');
      if (colorInput) colorInput.value = shape.stroke;
      if (widthSelect) widthSelect.value = shape.strokeWidth;
      strokeColor = shape.stroke;
      strokeWidth = shape.strokeWidth;
    }
  } else {
    if (deleteBtn) deleteBtn.setAttribute('disabled', '');
  }
}

/**
 * Deletes the currently selected shape from Yjs.
 */
function deleteSelectedShape() {
  if (selectedShapeId && yshapes && yshapes.has(selectedShapeId)) {
    ydocRef.transact(() => {
      yshapes.delete(selectedShapeId);
    });
    setSelectedShape(null);
  }
}

/**
 * Set up key events like Delete to delete shapes.
 */
function setupKeyEvents() {
  const handler = (e) => {
    // Only intercept if we are focused on the body and not typing in input/textarea
    const activeTagName = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTagName === 'input' || activeTagName === 'textarea') return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedShapeId) {
        e.preventDefault();
        deleteSelectedShape();
      }
    }
  };

  window.addEventListener('keydown', handler);
}

/**
 * Setup and synchronize awareness pointers on whiteboard canvas.
 */
function setupPointerSync(provider) {
  const cursorsGroup = document.getElementById('wb-cursors-group');
  if (!cursorsGroup) return;

  provider.awareness.on('change', () => {
    // Clear old pointer elements that are not active
    const activeClientIds = new Set(Array.from(provider.awareness.getStates().keys()));
    const pointerElements = cursorsGroup.querySelectorAll('.wb-pointer');
    
    pointerElements.forEach(el => {
      const cid = parseInt(el.dataset.clientId, 10);
      if (!activeClientIds.has(cid)) {
        el.parentNode.removeChild(el);
      }
    });

    // Draw active remote pointers
    provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === provider.awareness.clientID) return; // skip local client
      
      const pointer = state.canvasPointer;
      const user = state.user;

      if (!pointer || pointer.room !== currentRoom) {
        // Remove pointer from DOM if exists
        const el = document.getElementById(`wb-pointer-${clientId}`);
        if (el) el.parentNode.removeChild(el);
        return;
      }

      let pointerEl = document.getElementById(`wb-pointer-${clientId}`);
      if (!pointerEl) {
        pointerEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        pointerEl.id = `wb-pointer-${clientId}`;
        pointerEl.setAttribute('class', 'wb-pointer');
        pointerEl.dataset.clientId = clientId;

        // Custom pointer cursor arrow svg path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('class', 'wb-pointer-cursor');
        path.setAttribute('d', 'M 0,0 L 0,15 L 4,11 L 10,11 Z');
        pointerEl.appendChild(path);

        // Floating name badge
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('class', 'wb-pointer-label');
        text.setAttribute('x', '12');
        text.setAttribute('y', '10');
        pointerEl.appendChild(text);

        cursorsGroup.appendChild(pointerEl);
      }

      // Update position, color and user name text
      pointerEl.setAttribute('transform', `translate(${pointer.x}, ${pointer.y})`);
      pointerEl.style.color = user?.color || '#3b82f6';
      
      const textEl = pointerEl.querySelector('.wb-pointer-label');
      if (textEl) {
        textEl.textContent = user?.name || 'Guest Collaborator';
      }
    });
  });
}
