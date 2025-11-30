/**
 * Canvas Manager
 * 
 * Central coordinator for the Canvas layer system.
 * Manages layers, chart rendering, and UI synchronization.
 * 
 * Responsibilities:
 * - Layer lifecycle management (add, remove, update)
 * - Chart rendering and updates via Chart.js
 * - UI synchronization (layer list, properties panel)
 * - Data fetching and caching
 * - State persistence
 */

import type { User } from '@supabase/supabase-js';
import type { 
  LayerType, 
  AnyLayerConfig, 
  DataSeries,
  HistoricalLayerConfig,
  RecipeLayerConfig,
  GeneratorLayerConfig,
  SimulatorLayerConfig
} from './types';
import { Chart, registerables } from 'chart.js';
import { HistoricalLayer } from './HistoricalLayer';
import { RecipeLayer } from './RecipeLayer';
import { GeneratorLayer } from './GeneratorLayer';
import { SimulatorLayer } from './SimulatorLayer';
import { supabase } from '../../lib/supabase';

// Register Chart.js components
Chart.register(...registerables);

/**
 * CanvasManager class
 * Coordinates all canvas operations and maintains application state
 */
export class CanvasManager {
  private user: User;
  private layers: Map<string, AnyLayerConfig> = new Map();
  private selectedLayerId: string | null = null;
  private highlightedLayerId: string | null = null; // Track which layer is currently highlighted
  private chart: any = null;
  
  // Layer handler instances (for rendering properties and fetching data)
  private layerHandlers: Map<string, HistoricalLayer | RecipeLayer | GeneratorLayer | SimulatorLayer> = new Map();
  
  // Map dataset labels to layer IDs for chart hover events
  // Key: dataset label, Value: layer ID
  private datasetToLayerMap: Map<string, string> = new Map();
  
  // DOM elements
  private readonly layerListEl: HTMLElement;
  private readonly propertiesContentEl: HTMLElement;
  private readonly chartCanvasEl: HTMLCanvasElement;
  private readonly chartEmptyStateEl: HTMLElement;
  
  // Color palette for auto-assigning layer colors
  private readonly colorPalette = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'
  ];
  private colorIndex = 0;
  
  constructor(user: User) {
    this.user = user;
    
    // Get DOM elements
    this.layerListEl = document.getElementById('layer-list')!;
    this.propertiesContentEl = document.getElementById('properties-content')!;
    this.chartCanvasEl = document.getElementById('main-canvas-chart') as HTMLCanvasElement;
    this.chartEmptyStateEl = document.getElementById('chart-empty-state')!;
  }
  
  /**
   * Initialize the Canvas manager
   * Sets up the chart and loads any saved state
   */
  async initialize(): Promise<void> {
    console.log('Initializing CanvasManager...');
    
    // Initialize Chart.js
    this.initializeChart();
    
    // Load saved canvas state from localStorage (if any)
    await this.loadCanvasState();
    
    console.log('✅ CanvasManager initialized');
  }
  
  /**
   * Initialize Chart.js with empty configuration
   * Will be populated as layers are added
   */
  private initializeChart(): void {
    const ctx = this.chartCanvasEl.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get canvas context');
    }
    
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        datasets: []
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 300
        },
        plugins: {
          legend: {
            display: false  // Disabled - layer cards provide identification, highlighting shows relationships
          },
          tooltip: {
            mode: 'nearest',
            intersect: true,  // Only show tooltip when cursor is actually over a trace
            callbacks: {
              label: (context: any) => {
                const label = context.dataset.label || '';
                const value = context.parsed.y.toFixed(1);
                const unit = context.dataset.yAxisID === 'y2' ? ' °C/min' : '°C';
                return `${label}: ${value}${unit}`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: {
              display: true,
              text: 'Time (mm:ss)',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            ticks: {
              callback: function(value: any) {
                // Convert seconds to MM:SS format for display
                const totalSeconds = Math.floor(value);
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = totalSeconds % 60;
                return `${minutes}:${seconds.toString().padStart(2, '0')}`;
              }
            }
          },
          y: {
            type: 'linear',
            title: {
              display: true,
              text: 'Temperature (°C)',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            position: 'left',
            // Constrain y-axis to 0-350°C range unless data exceeds these limits
            // Using suggestedMin/Max allows the chart to expand if needed
            suggestedMin: 0,
            suggestedMax: 350
          },
          y2: {
            type: 'linear',
            title: {
              display: true,
              text: 'Rate of Rise (°C/min)',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            position: 'right',
            grid: {
              drawOnChartArea: false
            },
            // Constrain RoR axis to 0-30°C/min range unless data exceeds these limits
            // Using suggestedMin/Max allows the chart to expand if needed
            suggestedMin: 0,
            suggestedMax: 30
          }
        },
        interaction: {
          mode: 'nearest',
          intersect: true  // Only interact when cursor is directly over plot elements
        }
      }
    });
    
    console.log('✓ Chart initialized');
  }
  
  /**
   * Add a new layer to the canvas
   * @param layerType - Type of layer to add
   */
  async addLayer(layerType: LayerType): Promise<void> {
    console.log(`Adding ${layerType} layer...`);
    
    // Generate unique ID for the layer
    const layerId = `${layerType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Get next color from palette
    const color = this.colorPalette[this.colorIndex % this.colorPalette.length];
    this.colorIndex++;
    
    // Create default layer configuration based on type
    const layerConfig = this.createDefaultLayerConfig(layerId, layerType, color);
    
    // Add to layers map
    this.layers.set(layerId, layerConfig);
    
    // Update UI
    this.updateLayerList();
    this.updateChart();
    
    // Select the newly added layer
    this.selectLayer(layerId);
    
    // Save state
    this.saveCanvasState();
    
    console.log(`✓ Added ${layerType} layer: ${layerId}`);
  }
  
  /**
   * Create default configuration for a new layer
   * @param layerId - Unique layer ID
   * @param layerType - Type of layer
   * @param color - Assigned color
   */
  private createDefaultLayerConfig(
    layerId: string, 
    layerType: LayerType, 
    color: string
  ): AnyLayerConfig {
    // Base configuration shared by all layers
    const baseConfig = {
      id: layerId,
      name: `${layerType.charAt(0).toUpperCase() + layerType.slice(1)} Layer`,
      visible: true,
      opacity: 1.0
    };
    
    // Type-specific configuration
    // Note: These are placeholder defaults - full implementation would
    // show selection dialogs for roasts/recipes/models
    switch (layerType) {
      case 'historical':
        return {
          ...baseConfig,
          type: 'historical',
          roastIds: [],
          showBeanTemp: true,
          showEnvTemp: true,
          showRoR: true,
          showHeater: true,
          showFan: true,
          showDrum: true,
          alignAtCharge: true,
          color
        };
      
      case 'recipe':
        return {
          ...baseConfig,
          type: 'recipe',
          recipeId: '',
          showBeanTemp: true,
          showEnvTemp: true,
          showRoR: true,
          showHeater: true,
          showFan: true,
          showDrum: true,
          color
        };
      
      case 'simulator':
        return {
          ...baseConfig,
          type: 'simulator',
          roasterModelId: '',
          beanModelId: '',
          beanMassG: 150,
          ambientTempC: 24,
          preheatTempC: 180,
          durationSeconds: 600,
          heaterProfile: [
            { time: 0, value: 0.5 },
            { time: 600, value: 0.5 }
          ],
          fanProfile: [
            { time: 0, value: 0.5 },
            { time: 600, value: 0.5 }
          ],
          drumProfile: [
            { time: 0, value: 0.6 },
            { time: 600, value: 0.6 }
          ],
          color
        };
      
      case 'generator':
        return {
          ...baseConfig,
          type: 'generator',
          roasterModelId: '',
          beanModelId: '',
          beanMassG: 150,
          ambientTempC: 24,
          preheatTempC: 180,
          durationSeconds: 600,
          heaterProfile: [
            { time: 0, value: 0.5 },
            { time: 600, value: 0.5 }
          ],
          fanProfile: [
            { time: 0, value: 0.5 },
            { time: 600, value: 0.5 }
          ],
          drumProfile: [
            { time: 0, value: 0.6 },
            { time: 600, value: 0.6 }
          ],
          color
        };
    }
  }
  
  /**
   * Remove a layer from the canvas
   * @param layerId - ID of layer to remove
   */
  async removeLayer(layerId: string): Promise<void> {
    this.layers.delete(layerId);
    
    // Deselect if this was the selected layer
    if (this.selectedLayerId === layerId) {
      this.selectedLayerId = null;
    }
    
    // Update UI
    this.updateLayerList();
    await this.updateChart();
    this.updatePropertiesPanel();
    
    // Save state
    this.saveCanvasState();
  }
  
  /**
   * Clear all layers from the canvas
   */
  async clearAllLayers(): Promise<void> {
    if (this.layers.size === 0) {
      return; // Nothing to clear
    }
    
    // Confirm before clearing
    if (!confirm(`Are you sure you want to remove all ${this.layers.size} layer(s)?`)) {
      return;
    }
    
    // Clear all layers
    this.layers.clear();
    this.layerHandlers.clear();
    this.selectedLayerId = null;
    
    // Update UI
    this.updateLayerList();
    await this.updateChart();
    this.updatePropertiesPanel();
    
    // Save state
    this.saveCanvasState();
    
    console.log('✓ All layers cleared');
  }
  
  /**
   * Toggle layer visibility
   * @param layerId - ID of layer to toggle
   */
  async toggleLayerVisibility(layerId: string): Promise<void> {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    
    layer.visible = !layer.visible;
    
    // Update UI
    this.updateLayerList();
    await this.updateChart();
    
    // Save state
    this.saveCanvasState();
  }
  
  /**
   * Highlight a layer (dim all others, make this one bold)
   * @param layerId - ID of layer to highlight, or null to clear highlight
   */
  private highlightLayer(layerId: string | null): void {
    // Only update if highlight state actually changes
    if (this.highlightedLayerId === layerId) return;
    
    this.highlightedLayerId = layerId;
    
    // Update chart rendering with new highlight state
    this.updateChartHighlight();
  }
  
  /**
   * Clear layer highlighting (restore all layers to normal state)
   */
  private clearHighlight(): void {
    this.highlightLayer(null);
  }
  
  /**
   * Deselect the currently selected layer
   * Clears selection and highlighting
   */
  deselectLayer(): void {
    this.selectedLayerId = null;
    this.clearHighlight();
    
    // Update UI
    this.updateLayerList();
    this.updatePropertiesPanel();
  }
  
  /**
   * Select a layer for editing in the properties panel
   * Also highlights the layer when selected
   * @param layerId - ID of layer to select
   */
  selectLayer(layerId: string): void {
    this.selectedLayerId = layerId;
    
    // Also highlight the selected layer
    this.highlightLayer(layerId);
    
    // Show properties panel when a layer is selected (if it's currently collapsed)
    const propertiesPanel = document.getElementById('properties-panel');
    const togglePropertiesBtn = document.getElementById('toggle-properties-btn');
    
    if (propertiesPanel && togglePropertiesBtn && propertiesPanel.classList.contains('collapsed')) {
      // Panel is collapsed, so show it
      propertiesPanel.classList.remove('collapsed');
      togglePropertiesBtn.textContent = '▶';
      togglePropertiesBtn.title = 'Hide properties panel';
      
      // Dispatch custom event to notify canvas.ts of the state change
      window.dispatchEvent(new CustomEvent('properties-panel-shown'));
      
      // Update canvas layout
      const canvasLayout = document.getElementById('canvas-layout');
      if (canvasLayout) {
        canvasLayout.classList.remove('properties-collapsed', 'both-collapsed');
        // Check if layers panel is collapsed
        const layerPanel = document.getElementById('layer-panel');
        if (layerPanel && layerPanel.classList.contains('collapsed')) {
          canvasLayout.classList.add('layers-collapsed');
        }
      }
    }
    
    // Update UI
    this.updateLayerList();
    this.updatePropertiesPanel();
  }
  
  /**
   * Update the layer list UI
   * Renders all layers in the left panel
   */
  private updateLayerList(): void {
    // Clear existing content
    this.layerListEl.innerHTML = '';
    
    // Show empty state if no layers
    if (this.layers.size === 0) {
      this.layerListEl.innerHTML = `
        <div class="empty-layer-state">
          <div class="empty-icon">📋</div>
          <p>No layers yet</p>
          <p class="hint">Click "Add Layer" to start</p>
        </div>
      `;
      return;
    }
    
    // Render each layer
    for (const [layerId, layer] of this.layers) {
      const layerEl = this.createLayerElement(layerId, layer);
      this.layerListEl.appendChild(layerEl);
    }
  }
  
  /**
   * Update a single layer card in the UI without re-rendering all layers
   * This prevents the visual jarring effect of all layers showing "Loading..." when one changes
   * @param layerId - ID of the layer to update
   */
  private updateSingleLayerCard(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    
    // Find the existing layer element in the DOM
    const existingLayerEl = document.querySelector(`[data-layer-id="${layerId}"]`)?.closest('.layer-item');
    if (!existingLayerEl) {
      // If not found, fall back to full update (shouldn't happen normally)
      this.updateLayerList();
      return;
    }
    
    // Create the new layer element
    const newLayerEl = this.createLayerElement(layerId, layer);
    
    // Replace the old element with the new one
    existingLayerEl.replaceWith(newLayerEl);
  }
  
  /**
   * Create a DOM element for a layer
   * @param layerId - Layer ID
   * @param layer - Layer configuration
   */
  private createLayerElement(layerId: string, layer: AnyLayerConfig): HTMLElement {
    const div = document.createElement('div');
    div.className = 'layer-item';
    if (this.selectedLayerId === layerId) {
      div.className += ' selected';
    }
    
    // Get icon based on layer type
    const icons = {
      historical: '📈',
      recipe: '📝',
      simulator: '🔬',
      generator: '✨'
    };
    const icon = icons[layer.type];
    
    // Get color for the layer (if available)
    // All layer types now store color in the same way
    let layerColor = '#999999'; // Default gray color
    if ('color' in layer && layer.color) {
      layerColor = layer.color;
    }
    
    // Get detailed info for the layer (will be populated asynchronously)
    const detailsHtml = this.getLayerDetailsHTML(layer);
    
    div.innerHTML = `
      <div class="layer-header">
        <button class="layer-visibility ${!layer.visible ? 'hidden' : ''}" data-layer-id="${layerId}">
          ${layer.visible ? '👁️' : '👁️‍🗨️'}
        </button>
        <span class="layer-color-swatch" style="background-color: ${layerColor};" title="Layer color"></span>
        <span class="layer-icon">${icon}</span>
        <span class="layer-name">${layer.name}</span>
        <div class="layer-actions">
          <button class="layer-action-btn" data-action="delete" data-layer-id="${layerId}" title="Delete layer">
            🗑️
          </button>
        </div>
      </div>
      <div class="layer-info" id="layer-info-${layerId}">${detailsHtml}</div>
    `;
    
    // Add click handler for selection
    div.addEventListener('click', (e) => {
      // Don't select if clicking on buttons
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.selectLayer(layerId);
    });
    
    // Add hover handlers for highlighting
    div.addEventListener('mouseenter', () => {
      // Highlight this layer when hovering over the card
      this.highlightLayer(layerId);
    });
    
    div.addEventListener('mouseleave', () => {
      // When leaving the layer card:
      // - If a layer is selected, keep it highlighted
      // - Otherwise, clear the highlight
      if (this.selectedLayerId) {
        this.highlightLayer(this.selectedLayerId);
      } else {
        this.clearHighlight();
      }
    });
    
    // Add handlers for action buttons
    const visibilityBtn = div.querySelector('.layer-visibility');
    if (visibilityBtn) {
      visibilityBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleLayerVisibility(layerId);
      });
    }
    
    const deleteBtn = div.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete layer "${layer.name}"?`)) {
          this.removeLayer(layerId);
        }
      });
    }
    
    return div;
  }
  
  /**
   * Get HTML for layer details based on layer type
   * This provides a synchronous initial render, with async updates if needed
   * @param layer - Layer configuration
   * @returns HTML string with layer details
   */
  private getLayerDetailsHTML(layer: AnyLayerConfig): string {
    switch (layer.type) {
      case 'generator':
      case 'simulator': {
        const config = layer as GeneratorLayerConfig | SimulatorLayerConfig;
        const details: string[] = [];
        
        // Roaster model (show loading if not loaded, will be updated async)
        if (config.roasterModelId) {
          details.push(`<div class="layer-detail-item" title="Roaster Model"><span class="detail-label">Roaster:</span> <span class="detail-value" id="roaster-model-${layer.id}">Loading...</span></div>`);
        } else {
          details.push(`<div class="layer-detail-item" title="Roaster Model"><span class="detail-label">Roaster:</span> <span class="detail-value">Not selected</span></div>`);
        }
        
        // Bean model
        if (config.beanModelId) {
          details.push(`<div class="layer-detail-item" title="Bean Model"><span class="detail-label">Bean:</span> <span class="detail-value" id="bean-model-${layer.id}">Loading...</span></div>`);
        } else {
          details.push(`<div class="layer-detail-item" title="Bean Model"><span class="detail-label">Bean:</span> <span class="detail-value">Not selected</span></div>`);
        }
        
        // Bean mass
        details.push(`<div class="layer-detail-item" title="Bean Mass"><span class="detail-label">Mass:</span> <span class="detail-value">${config.beanMassG}g</span></div>`);
        
        // Trigger async load of model names
        if (config.roasterModelId || config.beanModelId) {
          this.loadModelNamesAsync(layer.id, config.roasterModelId, config.beanModelId);
        }
        
        return details.join('');
      }
      
      case 'recipe': {
        const config = layer as RecipeLayerConfig;
        const details: string[] = [];
        
        if (config.recipeId) {
          // Recipe details (will be loaded async)
          details.push(`<div class="layer-detail-item" title="Recipe Name"><span class="detail-label">Recipe:</span> <span class="detail-value" id="recipe-name-${layer.id}">Loading...</span></div>`);
          details.push(`<div class="layer-detail-item" title="Roaster Model"><span class="detail-label">Roaster:</span> <span class="detail-value" id="recipe-roaster-${layer.id}">Loading...</span></div>`);
          details.push(`<div class="layer-detail-item" title="Bean Model"><span class="detail-label">Bean:</span> <span class="detail-value" id="recipe-bean-${layer.id}">Loading...</span></div>`);
          details.push(`<div class="layer-detail-item" title="Bean Mass"><span class="detail-label">Mass:</span> <span class="detail-value" id="recipe-mass-${layer.id}">Loading...</span></div>`);
          
          // Trigger async load
          this.loadRecipeDetailsAsync(layer.id, config.recipeId);
        } else {
          details.push(`<div class="layer-detail-item"><span class="detail-value">No recipe selected</span></div>`);
        }
        
        return details.join('');
      }
      
      case 'historical': {
        const config = layer as HistoricalLayerConfig;
        const details: string[] = [];
        
        if (config.roastIds.length > 0) {
          // Roast details (will be loaded async)
          details.push(`<div class="layer-detail-item" title="Roaster"><span class="detail-label">Roaster:</span> <span class="detail-value" id="hist-roaster-${layer.id}">Loading...</span></div>`);
          details.push(`<div class="layer-detail-item" title="Bean Origin & Variety"><span class="detail-label">Bean:</span> <span class="detail-value" id="hist-bean-${layer.id}">Loading...</span></div>`);
          details.push(`<div class="layer-detail-item" title="Bean Mass"><span class="detail-label">Mass:</span> <span class="detail-value" id="hist-mass-${layer.id}">Loading...</span></div>`);
          
          // Trigger async load
          this.loadHistoricalDetailsAsync(layer.id, config.roastIds[0]);
        } else {
          details.push(`<div class="layer-detail-item"><span class="detail-value">No roast selected</span></div>`);
        }
        
        return details.join('');
      }
    }
  }
  
  /**
   * Load model names asynchronously and update the UI
   * @param layerId - Layer ID
   * @param roasterModelId - Roaster model ID
   * @param beanModelId - Bean model ID
   */
  private async loadModelNamesAsync(layerId: string, roasterModelId: string, beanModelId: string): Promise<void> {
    try {
      // Load roaster model name
      if (roasterModelId) {
        const { data: roasterData, error: roasterError } = await supabase
          .from('training_jobs')
          .select('job_name')
          .eq('id', roasterModelId)
          .single();
        
        if (!roasterError && roasterData) {
          const roasterEl = document.getElementById(`roaster-model-${layerId}`);
          if (roasterEl) {
            roasterEl.textContent = roasterData.job_name || 'Unnamed';
          }
        }
      }
      
      // Load bean model name
      if (beanModelId) {
        const { data: beanData, error: beanError } = await supabase
          .from('training_jobs')
          .select('job_name')
          .eq('id', beanModelId)
          .single();
        
        if (!beanError && beanData) {
          const beanEl = document.getElementById(`bean-model-${layerId}`);
          if (beanEl) {
            beanEl.textContent = beanData.job_name || 'Unnamed';
          }
        }
      }
    } catch (error) {
      console.error('Error loading model names:', error);
    }
  }
  
  /**
   * Load recipe details asynchronously and update the UI
   * @param layerId - Layer ID
   * @param recipeId - Recipe ID
   */
  private async loadRecipeDetailsAsync(layerId: string, recipeId: string): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('recipes')
        .select(`
          name,
          bean_mass_g,
          roaster_model:training_jobs!recipes_roaster_model_id_fkey(job_name),
          bean_model:training_jobs!recipes_bean_model_id_fkey(job_name)
        `)
        .eq('id', recipeId)
        .single();
      
      if (!error && data) {
        // Update recipe name
        const recipeNameEl = document.getElementById(`recipe-name-${layerId}`);
        if (recipeNameEl) {
          recipeNameEl.textContent = data.name || 'Unnamed';
        }
        
        // Update roaster model
        const roasterEl = document.getElementById(`recipe-roaster-${layerId}`);
        if (roasterEl) {
          roasterEl.textContent = (data.roaster_model as any)?.job_name || 'Unknown';
        }
        
        // Update bean model
        const beanEl = document.getElementById(`recipe-bean-${layerId}`);
        if (beanEl) {
          beanEl.textContent = (data.bean_model as any)?.job_name || 'Unknown';
        }
        
        // Update mass
        const massEl = document.getElementById(`recipe-mass-${layerId}`);
        if (massEl) {
          massEl.textContent = `${data.bean_mass_g}g`;
        }
      }
    } catch (error) {
      console.error('Error loading recipe details:', error);
    }
  }
  
  /**
   * Load historical roast details asynchronously and update the UI
   * @param layerId - Layer ID
   * @param roastId - Roast ID
   */
  private async loadHistoricalDetailsAsync(layerId: string, roastId: string): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('roasts')
        .select('roaster, origin, variety, charge_mass')
        .eq('id', roastId)
        .single();
      
      if (!error && data) {
        // Update roaster
        const roasterEl = document.getElementById(`hist-roaster-${layerId}`);
        if (roasterEl) {
          roasterEl.textContent = data.roaster || 'Unknown';
        }
        
        // Update bean info (origin and variety)
        const beanEl = document.getElementById(`hist-bean-${layerId}`);
        if (beanEl) {
          const origin = data.origin || 'Unknown';
          const variety = data.variety || 'Unknown';
          beanEl.textContent = `${origin} ${variety}`;
        }
        
        // Update mass
        const massEl = document.getElementById(`hist-mass-${layerId}`);
        if (massEl) {
          massEl.textContent = data.charge_mass ? `${data.charge_mass}g` : 'N/A';
        }
      }
    } catch (error) {
      console.error('Error loading historical roast details:', error);
    }
  }
  
  /**
   * Update the properties panel based on selected layer
   * Shows layer-specific controls
   */
  private async updatePropertiesPanel(): Promise<void> {
    if (!this.selectedLayerId) {
      // Show empty state
      this.propertiesContentEl.innerHTML = `
        <div class="empty-properties-state">
          <div class="empty-icon">⚙️</div>
          <p>Select a layer to view properties</p>
        </div>
      `;
      return;
    }
    
    const layer = this.layers.get(this.selectedLayerId);
    if (!layer) {
      this.propertiesContentEl.innerHTML = '<p>Layer not found</p>';
      return;
    }
    
    // Render properties based on layer type
    if (layer.type === 'historical') {
      // Use HistoricalLayer to render properties
      const histLayer = this.getOrCreateHistoricalLayer(this.selectedLayerId, layer as HistoricalLayerConfig);
      await histLayer.renderProperties(this.propertiesContentEl);
    } else if (layer.type === 'recipe') {
      // Use RecipeLayer to render properties
      const recipeLayer = this.getOrCreateRecipeLayer(this.selectedLayerId, layer as RecipeLayerConfig);
      await recipeLayer.renderProperties(this.propertiesContentEl);
    } else if (layer.type === 'generator') {
      // Use GeneratorLayer to render properties
      const genLayer = this.getOrCreateGeneratorLayer(this.selectedLayerId, layer as GeneratorLayerConfig);
      await genLayer.renderProperties(this.propertiesContentEl);
    } else if (layer.type === 'simulator') {
      // Use SimulatorLayer to render properties
      const simLayer = this.getOrCreateSimulatorLayer(this.selectedLayerId, layer as SimulatorLayerConfig);
      await simLayer.renderProperties(this.propertiesContentEl);
    }
  }
  
  /**
   * Get or create a HistoricalLayer handler for a layer
   * @param layerId - Layer ID
   * @param config - Layer configuration
   */
  private getOrCreateHistoricalLayer(layerId: string, config: HistoricalLayerConfig): HistoricalLayer {
    if (!this.layerHandlers.has(layerId)) {
      // Create new handler with callback to update chart
      const handler = new HistoricalLayer(
        this.user,
        config,
        () => {
          // When config changes, update only this layer's card, chart and save state
          // This prevents all layer cards from showing "Loading..." when one changes
          this.updateSingleLayerCard(layerId);
          this.updateChart();
          this.saveCanvasState();
        }
      );
      this.layerHandlers.set(layerId, handler);
    }
    return this.layerHandlers.get(layerId) as HistoricalLayer;
  }
  
  /**
   * Get or create a RecipeLayer handler for a layer
   * @param layerId - Layer ID
   * @param config - Layer configuration
   */
  private getOrCreateRecipeLayer(layerId: string, config: RecipeLayerConfig): RecipeLayer {
    if (!this.layerHandlers.has(layerId)) {
      // Create new handler with callback to update chart
      const handler = new RecipeLayer(
        this.user,
        config,
        () => {
          // When config changes, update only this layer's card, chart and save state
          // This prevents all layer cards from showing "Loading..." when one changes
          this.updateSingleLayerCard(layerId);
          this.updateChart();
          this.saveCanvasState();
        }
      );
      this.layerHandlers.set(layerId, handler);
    }
    return this.layerHandlers.get(layerId) as RecipeLayer;
  }
  
  /**
   * Get or create a GeneratorLayer handler for a layer
   * @param layerId - Layer ID
   * @param config - Layer configuration
   */
  private getOrCreateGeneratorLayer(layerId: string, config: GeneratorLayerConfig): GeneratorLayer {
    if (!this.layerHandlers.has(layerId)) {
      // Create new handler with callback to update chart
      const handler = new GeneratorLayer(
        this.user,
        config,
        () => {
          // When config changes, update only this layer's card, chart and save state
          // This prevents all layer cards from showing "Loading..." when one changes
          this.updateSingleLayerCard(layerId);
          this.updateChart();
          this.saveCanvasState();
        }
      );
      this.layerHandlers.set(layerId, handler);
    }
    return this.layerHandlers.get(layerId) as GeneratorLayer;
  }
  
  /**
   * Get or create a SimulatorLayer handler for a layer
   * @param layerId - Layer ID
   * @param config - Layer configuration
   */
  private getOrCreateSimulatorLayer(layerId: string, config: SimulatorLayerConfig): SimulatorLayer {
    if (!this.layerHandlers.has(layerId)) {
      // Create new handler with TWO callbacks:
      // 1. Full update callback for configuration changes
      // 2. Chart-only update callback for simulation data updates (avoids re-rendering layer list)
      const handler = new SimulatorLayer(
        this.user,
        config,
        () => {
          // Full update: When config changes, update only this layer's card, chart and save state
          // This prevents all layer cards from showing "Loading..." when one changes
          this.updateSingleLayerCard(layerId);
          this.updateChart();
          this.saveCanvasState();
        },
        () => {
          // Chart-only update: For simulation data updates, only update the chart
          // This avoids re-rendering the layer list which would break hover states
          this.updateChart();
        }
      );
      this.layerHandlers.set(layerId, handler);
    }
    return this.layerHandlers.get(layerId) as SimulatorLayer;
  }
  
  /**
   * Update the chart with current layer data
   * Re-renders all visible layers
   */
  private async updateChart(): Promise<void> {
    if (!this.chart) return;
    
    // Show/hide empty state
    if (this.layers.size === 0) {
      this.chartEmptyStateEl.style.display = 'block';
      this.chartCanvasEl.style.display = 'none';
      return;
    } else {
      this.chartEmptyStateEl.style.display = 'none';
      this.chartCanvasEl.style.display = 'block';
    }
    
    // Clear dataset-to-layer mapping
    this.datasetToLayerMap.clear();
    
    // Collect datasets from all visible layers
    const datasets: any[] = [];
    
    for (const [, layer] of this.layers) {
      if (!layer.visible) continue;
      
      // Get data series for this layer
      const dataSeries = await this.getLayerDataSeries(layer);
      
      // Convert data series to Chart.js datasets
      for (const series of dataSeries) {
        const dataset = this.createChartDataset(series, layer.opacity, layer.id);
        datasets.push(dataset);
        
        // Map dataset label to layer ID for hover detection
        // Use the dataset's actual label (which may have been modified to be unique)
        this.datasetToLayerMap.set(dataset.label, layer.id);
      }
    }
    
    // Update chart
    this.chart.data.datasets = datasets;
    this.chart.update('none'); // 'none' = no animation
    
    // Set up chart hover handlers for highlighting
    this.setupChartHoverHandlers();
    
    // Restore highlighting if a layer is highlighted
    // This ensures that after data updates, the highlight state is preserved
    if (this.highlightedLayerId) {
      this.updateChartHighlight();
    }
  }
  
  /**
   * Update chart highlighting without re-fetching data
   * This is more efficient than updateChart() when only the highlight state changes
   */
  private updateChartHighlight(): void {
    if (!this.chart || !this.chart.data.datasets) return;
    
    // Update each dataset's visual properties based on highlight state
    for (const dataset of this.chart.data.datasets) {
      // Get the layer ID for this dataset from its label
      const layerId = this.datasetToLayerMap.get(dataset.label);
      if (!layerId) continue;
      
      const layer = this.layers.get(layerId);
      if (!layer) continue;
      
      // Determine if this dataset should be highlighted or dimmed
      const isHighlighted = !this.highlightedLayerId || this.highlightedLayerId === layerId;
      
      // Apply highlighting effects
      // When highlighted: use full opacity and increase line width
      // When dimmed: use reduced opacity (20%) and normal line width
      const effectiveOpacity = isHighlighted ? layer.opacity : layer.opacity * 0.2;
      const effectiveLineWidth = isHighlighted ? dataset.originalLineWidth * 1.5 : dataset.originalLineWidth;
      
      // Update dataset visual properties
      // Note: We need to preserve the original color and just modify alpha
      if (dataset.originalBorderColor) {
        dataset.borderColor = this.adjustColorOpacity(dataset.originalBorderColor, effectiveOpacity);
      }
      if (dataset.originalBackgroundColor) {
        dataset.backgroundColor = this.adjustColorOpacity(dataset.originalBackgroundColor, effectiveOpacity);
      }
      if (dataset.originalPointBackgroundColor) {
        dataset.pointBackgroundColor = this.adjustColorOpacity(dataset.originalPointBackgroundColor, effectiveOpacity);
      }
      
      dataset.borderWidth = effectiveLineWidth;
    }
    
    // Update the chart without animation
    this.chart.update('none');
  }
  
  /**
   * Set up chart hover handlers to highlight layers on mouseover
   */
  private setupChartHoverHandlers(): void {
    if (!this.chart) return;
    
    const canvas = this.chartCanvasEl;
    
    // Handle mouse move over chart to detect dataset hover
    canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const points = this.chart.getElementsAtEventForMode(
        e,
        'nearest',
        { intersect: true },  // Only highlight when cursor is directly over a trace
        false
      );
      
      if (points && points.length > 0) {
        // Get the dataset at the hover point
        const datasetIndex = points[0].datasetIndex;
        const dataset = this.chart.data.datasets[datasetIndex];
        
        if (dataset && dataset.label) {
          // Find the layer ID for this dataset
          const layerId = this.datasetToLayerMap.get(dataset.label);
          if (layerId) {
            this.highlightLayer(layerId);
          }
        }
      }
    });
    
    // Clear highlight when mouse leaves the chart
    canvas.addEventListener('mouseleave', () => {
      // Only clear if we're not in the properties panel (keep selected layer highlighted)
      if (!this.selectedLayerId) {
        this.clearHighlight();
      } else {
        // Keep selected layer highlighted
        this.highlightLayer(this.selectedLayerId);
      }
    });
  }
  
  /**
   * Get data series for a layer
   * @param layer - Layer configuration
   * @returns Array of data series
   */
  private async getLayerDataSeries(layer: AnyLayerConfig): Promise<DataSeries[]> {
    // For historical layers, use HistoricalLayer to fetch data
    if (layer.type === 'historical') {
      const histLayer = this.getOrCreateHistoricalLayer(layer.id, layer as HistoricalLayerConfig);
      return await histLayer.getDataSeries();
    }
    
    // For recipe layers, use RecipeLayer to fetch data
    if (layer.type === 'recipe') {
      const recipeLayer = this.getOrCreateRecipeLayer(layer.id, layer as RecipeLayerConfig);
      return await recipeLayer.getDataSeries();
    }
    
    // For generator layers, use GeneratorLayer to fetch data
    if (layer.type === 'generator') {
      const genLayer = this.getOrCreateGeneratorLayer(layer.id, layer as GeneratorLayerConfig);
      return await genLayer.getDataSeries();
    }
    
    // For simulator layers, use SimulatorLayer to fetch data
    if (layer.type === 'simulator') {
      const simLayer = this.getOrCreateSimulatorLayer(layer.id, layer as SimulatorLayerConfig);
      return await simLayer.getDataSeries();
    }
    
    // All layer types should be handled above (TypeScript exhaustiveness checking)
    // This should never be reached
    return [];
  }
  
  /**
   * Convert a data series to a Chart.js dataset
   * @param series - Data series
   * @param opacity - Layer opacity (0-1)
   * @param layerId - Layer ID (for tracking which layer owns this dataset)
   * 
   * The opacity parameter controls the transparency of all visual elements:
   * - Line color (borderColor)
   * - Point color (pointBackgroundColor)
   * - Fill area color (backgroundColor)
   * 
   * We store original styling properties for dynamic highlighting adjustments
   */
  private createChartDataset(series: DataSeries, opacity: number, layerId: string): any {
    const style = series.style;
    
    // Create the dataset with original colors stored for later adjustment
    const borderColor = this.hexToRgba(style.color, opacity);
    const backgroundColor = style.fill 
      ? this.hexToRgba(style.color, style.fillOpacity * opacity)
      : 'transparent';
    const pointBackgroundColor = this.hexToRgba(style.color, opacity);
    
    return {
      label: series.label,
      data: series.data,
      // Current visual properties
      borderColor,
      backgroundColor,
      borderWidth: style.lineWidth,
      borderDash: style.lineDash,
      pointRadius: style.showPoints ? style.pointRadius : 0,
      pointBackgroundColor,
      fill: style.fill,
      tension: 0.1,
      stepped: style.stepped || false,  // Support stepped line mode for piecewise constant data
      yAxisID: series.yAxisID || 'y',
      // Store original properties for highlighting adjustments
      // These preserve the base color in rgba format so we can adjust opacity dynamically
      originalBorderColor: borderColor,
      originalBackgroundColor: backgroundColor,
      originalPointBackgroundColor: pointBackgroundColor,
      originalLineWidth: style.lineWidth,
      layerId // Store layer ID for reference
    };
  }
  
  /**
   * Adjust the opacity of an rgba color string
   * @param rgbaColor - Color in rgba format, e.g., "rgba(255, 0, 0, 0.8)"
   * @param newAlpha - New alpha value (0-1)
   * @returns New rgba color with adjusted alpha
   */
  private adjustColorOpacity(rgbaColor: string, newAlpha: number): string {
    // Parse rgba color string
    // Format: rgba(r, g, b, a) or rgb(r, g, b)
    const match = rgbaColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    
    if (!match) {
      // If parsing fails, return the original color
      console.warn('Failed to parse color:', rgbaColor);
      return rgbaColor;
    }
    
    const r = match[1];
    const g = match[2];
    const b = match[3];
    
    // Return new rgba with adjusted alpha
    return `rgba(${r}, ${g}, ${b}, ${newAlpha})`;
  }
  
  /**
   * Convert hex color to rgba
   * @param hex - Hex color code
   * @param alpha - Alpha value (0-1)
   */
  private hexToRgba(hex: string, alpha: number): string {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!result) return 'rgba(0,0,0,0)';
    
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  
  /**
   * Resize the chart to fit its container
   * Should be called when the container dimensions change (e.g., sidebar toggle)
   * This triggers Chart.js to recalculate the canvas dimensions based on its container
   */
  resizeChart(): void {
    if (this.chart) {
      // Chart.js resize() method recalculates dimensions based on container
      this.chart.resize();
    }
  }
  
  /**
   * Reset chart zoom to show all data
   */
  resetZoom(): void {
    if (this.chart) {
      this.chart.resetZoom();
    }
  }
  
  /**
   * Export chart as PNG image
   */
  exportChart(): void {
    if (!this.chart) return;
    
    const url = this.chart.toBase64Image();
    const link = document.createElement('a');
    link.download = `canvas-export-${Date.now()}.png`;
    link.href = url;
    link.click();
  }
  
  /**
   * Save canvas state to localStorage
   */
  private saveCanvasState(): void {
    try {
      const state = {
        layers: Array.from(this.layers.values()),
        timestamp: Date.now()
      };
      
      localStorage.setItem('canvas-state', JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save canvas state:', error);
    }
  }
  
  /**
   * Load canvas state from localStorage
   */
  private async loadCanvasState(): Promise<void> {
    try {
      const stateStr = localStorage.getItem('canvas-state');
      if (!stateStr) return;
      
      const state = JSON.parse(stateStr);
      
      // Restore layers
      for (const layer of state.layers) {
        this.layers.set(layer.id, layer);
      }
      
      // Pre-initialize all layer handlers to ensure they're ready to provide data
      // This is critical for layers restored from localStorage
      for (const [layerId, layer] of this.layers) {
        if (layer.type === 'historical') {
          const histLayer = this.getOrCreateHistoricalLayer(layerId, layer as HistoricalLayerConfig);
          // HistoricalLayer needs to load roasts list before it can provide data
          await (histLayer as any).loadRoasts?.();
        } else if (layer.type === 'recipe') {
          const recipeLayer = this.getOrCreateRecipeLayer(layerId, layer as RecipeLayerConfig);
          // RecipeLayer needs to load recipes list before it can provide data
          await (recipeLayer as any).loadRecipes?.();
        } else if (layer.type === 'generator') {
          const genLayer = this.getOrCreateGeneratorLayer(layerId, layer as GeneratorLayerConfig);
          // GeneratorLayer needs to load models and run simulation before it can provide data
          // Only if models were previously selected
          if (layer.roasterModelId && layer.beanModelId) {
            await (genLayer as any).loadModelsAndSimulate?.();
          }
        } else if (layer.type === 'simulator') {
          const simLayer = this.getOrCreateSimulatorLayer(layerId, layer as SimulatorLayerConfig);
          // SimulatorLayer needs to load models if they were previously selected
          if (layer.roasterModelId && layer.beanModelId) {
            await (simLayer as any).loadModelsIfNeeded?.();
          }
        }
      }
      
      // Update UI
      this.updateLayerList();
      await this.updateChart(); // Wait for chart to fully update with data
      
      console.log(`✓ Restored ${this.layers.size} layers from saved state`);
    } catch (error) {
      console.error('Failed to load canvas state:', error);
    }
  }
}
