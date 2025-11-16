/**
 * Canvas Page - Main Entry Point
 * 
 * Orchestrates the Canvas layer-based visualization system.
 * This is the single-page interface where users can stack multiple layers
 * of roast data for comparative analysis and recipe development.
 * 
 * Architecture:
 * - CanvasManager: Manages layers and coordinates chart updates
 * - CanvasChartManager: Handles Chart.js rendering
 * - Layer implementations: Historical, Recipe, Simulator, Generator
 * - UI Controllers: Layer tree, properties panel, chart controls
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import { CanvasManager } from './CanvasManager';
import type { LayerType } from './types';

// ========================================
// GLOBAL STATE
// ========================================
let currentUser: User | null = null;
let canvasManager: CanvasManager | null = null;

// ========================================
// DOM ELEMENTS
// ========================================
const messageDiv = document.getElementById('message') as HTMLDivElement;
const userEmailSpan = document.getElementById('user-email') as HTMLSpanElement;
const signoutBtn = document.getElementById('signout-btn') as HTMLButtonElement;

// Layer controls
const addLayerBtn = document.getElementById('add-layer-btn') as HTMLButtonElement;
const addFirstLayerBtn = document.getElementById('add-first-layer-btn') as HTMLButtonElement;
const clearAllLayersBtn = document.getElementById('clear-all-layers-btn') as HTMLButtonElement;
const layerTypeSelector = document.getElementById('layer-type-selector') as HTMLDivElement;
const closeLayerSelector = document.getElementById('close-layer-selector') as HTMLButtonElement;
const layerTypeOptions = document.querySelectorAll('.layer-type-option');

// Chart controls
const resetZoomBtn = document.getElementById('reset-zoom-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;

// Panel toggle controls
const toggleLayersBtn = document.getElementById('toggle-layers-btn') as HTMLButtonElement;
const togglePropertiesBtn = document.getElementById('toggle-properties-btn') as HTMLButtonElement;
const floatingToggleLayersBtn = document.getElementById('floating-toggle-layers') as HTMLButtonElement;
const canvasLayout = document.getElementById('canvas-layout') as HTMLDivElement;
const layerPanel = document.getElementById('layer-panel') as HTMLElement;
const propertiesPanel = document.getElementById('properties-panel') as HTMLElement;

// Panel visibility state
let layersPanelVisible = true;
let propertiesPanelVisible = true;

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Display a message to the user
 * @param text - Message text to display
 * @param type - Message type: 'error', 'success', or 'info'
 */
function showMessage(text: string, type: 'error' | 'success' | 'info'): void {
    messageDiv.textContent = text;
    messageDiv.className = `message ${type}`;
    messageDiv.style.display = 'block';
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 5000);
}

// ========================================
// AUTHENTICATION
// ========================================

/**
 * Check if user is authenticated
 * Redirect to login if not
 */
async function checkAuth(): Promise<void> {
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error || !session) {
            window.location.href = '/login.html';
            return;
        }
        
        currentUser = session.user;
        userEmailSpan.textContent = currentUser.email!;
        
    } catch (error) {
        console.error('Auth check error:', error);
        window.location.href = '/login.html';
    }
}

/**
 * Handle sign out
 */
async function handleSignOut(): Promise<void> {
    try {
        const { error } = await supabase.auth.signOut();
        
        if (error) throw error;
        
        window.location.href = '/login.html';
        
    } catch (error: any) {
        console.error('Sign out error:', error);
        showMessage('Failed to sign out. Please try again.', 'error');
    }
}

// ========================================
// LAYER TYPE SELECTION
// ========================================

/**
 * Show the layer type selector modal
 */
function showLayerTypeSelector(): void {
    // If the layers panel is collapsed, open it first
    // This ensures the layer type selector (which is inside the panel) is visible
    if (!layersPanelVisible) {
        toggleLayersPanel();
    }
    
    layerTypeSelector.style.display = 'block';
}

/**
 * Hide the layer type selector modal
 */
function hideLayerTypeSelector(): void {
    layerTypeSelector.style.display = 'none';
}

/**
 * Handle layer type selection
 * @param layerType - The selected layer type
 */
async function handleLayerTypeSelection(layerType: LayerType): Promise<void> {
    hideLayerTypeSelector();
    
    if (!canvasManager) {
        showMessage('Canvas manager not initialized', 'error');
        return;
    }
    
    try {
        // Create a new layer of the selected type
        await canvasManager.addLayer(layerType);
        showMessage(`Added ${layerType} layer`, 'success');
    } catch (error: any) {
        console.error('Failed to add layer:', error);
        showMessage(`Failed to add layer: ${error.message}`, 'error');
    }
}

// ========================================
// PANEL TOGGLES
// ========================================

/**
 * Toggle layers panel visibility
 * Navigation sidebar remains visible always
 */
function toggleLayersPanel(): void {
    layersPanelVisible = !layersPanelVisible;
    
    // Update panel visibility
    if (layersPanelVisible) {
        layerPanel.classList.remove('collapsed');
        toggleLayersBtn.textContent = '◀';
        toggleLayersBtn.title = 'Hide layers panel';
        floatingToggleLayersBtn.style.display = 'none';
    } else {
        layerPanel.classList.add('collapsed');
        toggleLayersBtn.textContent = '▶';
        toggleLayersBtn.title = 'Show layers panel';
        floatingToggleLayersBtn.style.display = 'block';
    }
    
    // Update canvas layout classes
    updateCanvasLayoutClasses();
}

/**
 * Toggle properties panel visibility
 * When closing the panel, also deselect the current layer
 */
function togglePropertiesPanel(): void {
    propertiesPanelVisible = !propertiesPanelVisible;
    
    // Update panel visibility
    if (propertiesPanelVisible) {
        propertiesPanel.classList.remove('collapsed');
        togglePropertiesBtn.textContent = '▶';
        togglePropertiesBtn.title = 'Hide properties panel';
    } else {
        propertiesPanel.classList.add('collapsed');
        togglePropertiesBtn.textContent = '◀';
        togglePropertiesBtn.title = 'Show properties panel';
        
        // Deselect the current layer when closing the properties panel
        if (canvasManager) {
            canvasManager.deselectLayer();
        }
    }
    
    // Update canvas layout classes
    updateCanvasLayoutClasses();
}

/**
 * Update canvas layout classes based on panel visibility
 * This function updates the CSS grid layout and then resizes the chart
 */
function updateCanvasLayoutClasses(): void {
    // Remove all collapse classes
    canvasLayout.classList.remove('layers-collapsed', 'properties-collapsed', 'both-collapsed');
    
    // Apply appropriate class based on current state
    if (!layersPanelVisible && !propertiesPanelVisible) {
        canvasLayout.classList.add('both-collapsed');
    } else if (!layersPanelVisible) {
        canvasLayout.classList.add('layers-collapsed');
    } else if (!propertiesPanelVisible) {
        canvasLayout.classList.add('properties-collapsed');
    }
    
    // Resize the chart after the CSS transition completes
    // The CSS transition duration is 0.3s, so we wait slightly longer to ensure it's complete
    setTimeout(() => {
        if (canvasManager) {
            canvasManager.resizeChart();
        }
    }, 350);
}

// ========================================
// CHART CONTROLS
// ========================================

/**
 * Reset chart zoom to show all data
 */
function handleResetZoom(): void {
    if (canvasManager) {
        canvasManager.resetZoom();
    }
}

/**
 * Export chart as PNG image
 */
function handleExportChart(): void {
    if (canvasManager) {
        canvasManager.exportChart();
    }
}

// ========================================
// EVENT LISTENERS
// ========================================

/**
 * Set up all event listeners
 */
function setupEventListeners(): void {
    // Sign out
    signoutBtn.addEventListener('click', handleSignOut);
    
    // Add layer buttons
    addLayerBtn.addEventListener('click', showLayerTypeSelector);
    addFirstLayerBtn.addEventListener('click', showLayerTypeSelector);
    
    // Clear all layers button
    clearAllLayersBtn.addEventListener('click', () => {
        if (canvasManager) {
            canvasManager.clearAllLayers();
        }
    });
    
    // Close layer selector
    closeLayerSelector.addEventListener('click', hideLayerTypeSelector);
    
    // Layer type options
    layerTypeOptions.forEach(option => {
        option.addEventListener('click', () => {
            const layerType = (option as HTMLElement).dataset.type as LayerType;
            if (layerType) {
                handleLayerTypeSelection(layerType);
            }
        });
    });
    
    // Chart controls
    resetZoomBtn.addEventListener('click', handleResetZoom);
    exportBtn.addEventListener('click', handleExportChart);
    
    // Panel toggle buttons
    toggleLayersBtn.addEventListener('click', toggleLayersPanel);
    togglePropertiesBtn.addEventListener('click', togglePropertiesPanel);
    floatingToggleLayersBtn.addEventListener('click', toggleLayersPanel);
    
    // Listen for properties panel changes from CanvasManager
    window.addEventListener('properties-panel-shown', () => {
        // Sync state when CanvasManager shows the properties panel
        propertiesPanelVisible = true;
        updateCanvasLayoutClasses();
    });
    
    // Close layer selector when clicking outside
    layerTypeSelector.addEventListener('click', (e) => {
        if (e.target === layerTypeSelector) {
            hideLayerTypeSelector();
        }
    });
    
    // Initially hide properties panel if no layer selected
    propertiesPanel.classList.add('collapsed');
    propertiesPanelVisible = false;
    togglePropertiesBtn.textContent = '◀';
    updateCanvasLayoutClasses();
}

// ========================================
// INITIALIZATION
// ========================================

/**
 * Initialize the Canvas page
 */
async function init(): Promise<void> {
    console.log('Initializing Canvas...');
    
    // Check authentication first
    await checkAuth();
    
    if (!currentUser) {
        console.error('No authenticated user');
        return;
    }
    
    // Set up event listeners
    setupEventListeners();
    
    // Initialize Canvas manager
    try {
        canvasManager = new CanvasManager(currentUser);
        await canvasManager.initialize();
        
        console.log('✅ Canvas initialized successfully');
    } catch (error) {
        console.error('Failed to initialize Canvas:', error);
        showMessage('Failed to initialize Canvas. Please refresh the page.', 'error');
    }
}

// Run initialization when page loads
init();
