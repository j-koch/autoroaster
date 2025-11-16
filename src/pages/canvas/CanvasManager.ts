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
  private chart: any = null;
  
  // Layer handler instances (for rendering properties and fetching data)
  private layerHandlers: Map<string, HistoricalLayer | RecipeLayer | GeneratorLayer | SimulatorLayer> = new Map();
  
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
    this.loadCanvasState();
    
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
            display: true,
            position: 'top',
            labels: {
              usePointStyle: true,
              padding: 15
            }
          },
          tooltip: {
            mode: 'nearest',
            intersect: false,
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
              text: 'Time (seconds)',
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
            position: 'left'
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
            }
          }
        },
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false
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
          ]
        };
    }
  }
  
  /**
   * Remove a layer from the canvas
   * @param layerId - ID of layer to remove
   */
  removeLayer(layerId: string): void {
    this.layers.delete(layerId);
    
    // Deselect if this was the selected layer
    if (this.selectedLayerId === layerId) {
      this.selectedLayerId = null;
    }
    
    // Update UI
    this.updateLayerList();
    this.updateChart();
    this.updatePropertiesPanel();
    
    // Save state
    this.saveCanvasState();
  }
  
  /**
   * Toggle layer visibility
   * @param layerId - ID of layer to toggle
   */
  toggleLayerVisibility(layerId: string): void {
    const layer = this.layers.get(layerId);
    if (!layer) return;
    
    layer.visible = !layer.visible;
    
    // Update UI
    this.updateLayerList();
    this.updateChart();
    
    // Save state
    this.saveCanvasState();
  }
  
  /**
   * Select a layer for editing in the properties panel
   * @param layerId - ID of layer to select
   */
  selectLayer(layerId: string): void {
    this.selectedLayerId = layerId;
    
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
    // Different layer types store color in different places
    let layerColor = '#999999'; // Default gray color
    if (layer.type === 'historical' && 'color' in layer) {
      layerColor = layer.color || '#e74c3c';
    }
    // Add other layer type color extraction as needed
    
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
      <div class="layer-info">${layer.type} layer</div>
    `;
    
    // Add click handler for selection
    div.addEventListener('click', (e) => {
      // Don't select if clicking on buttons
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.selectLayer(layerId);
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
          // When config changes, update chart and save state
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
          // When config changes, update chart and save state
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
          // When config changes, update chart and save state
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
      // Create new handler with callback to update chart
      const handler = new SimulatorLayer(
        this.user,
        config,
        () => {
          // When config changes, update chart and save state
          this.updateChart();
          this.saveCanvasState();
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
    
    // Collect datasets from all visible layers
    const datasets: any[] = [];
    
    for (const [, layer] of this.layers) {
      if (!layer.visible) continue;
      
      // Get data series for this layer
      // For now, using placeholder data - full implementation would
      // fetch actual data from each layer type
      const dataSeries = await this.getLayerDataSeries(layer);
      
      // Convert data series to Chart.js datasets
      for (const series of dataSeries) {
        datasets.push(this.createChartDataset(series, layer.opacity));
      }
    }
    
    // Update chart
    this.chart.data.datasets = datasets;
    this.chart.update('none'); // 'none' = no animation
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
   * @param opacity - Layer opacity
   */
  private createChartDataset(series: DataSeries, opacity: number): any {
    const style = series.style;
    
    return {
      label: series.label,
      data: series.data,
      borderColor: style.color,
      backgroundColor: style.fill 
        ? this.hexToRgba(style.color, style.fillOpacity * opacity)
        : 'transparent',
      borderWidth: style.lineWidth,
      borderDash: style.lineDash,
      pointRadius: style.showPoints ? style.pointRadius : 0,
      pointBackgroundColor: style.color,
      fill: style.fill,
      tension: 0.1,
      yAxisID: series.yAxisID || 'y'
    };
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
  private loadCanvasState(): void {
    try {
      const stateStr = localStorage.getItem('canvas-state');
      if (!stateStr) return;
      
      const state = JSON.parse(stateStr);
      
      // Restore layers
      for (const layer of state.layers) {
        this.layers.set(layer.id, layer);
      }
      
      // Update UI
      this.updateLayerList();
      this.updateChart();
      
      console.log(`✓ Restored ${this.layers.size} layers from saved state`);
    } catch (error) {
      console.error('Failed to load canvas state:', error);
    }
  }
}
