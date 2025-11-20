/**
 * Recipe Layer Implementation
 * 
 * Manages recipe visualization in the Canvas.
 * Provides:
 * - Recipe filtering and selection table (by roaster model and bean model)
 * - Live preview of selected recipe
 * - Color and transparency controls
 * - Toggle visibility for temperatures (ET, BT, RoR) and control inputs
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import type { RecipeLayerConfig, DataSeries, Recipe } from './types';

/**
 * RecipeLayer class
 * Handles all recipe layer operations
 */
export class RecipeLayer {
  private user: User;
  private config: RecipeLayerConfig;
  private allRecipes: Recipe[] = [];
  private filteredRecipes: Recipe[] = [];
  private selectedRecipeId: string | null = null;
  
  // Callback for when configuration changes (to trigger chart update)
  private onConfigChange: () => void;
  
  constructor(user: User, config: RecipeLayerConfig, onConfigChange: () => void) {
    this.user = user;
    this.config = config;
    this.onConfigChange = onConfigChange;
  }
  
  /**
   * Render the properties panel UI for this layer
   * @param container - DOM element to render into
   */
  async renderProperties(container: HTMLElement): Promise<void> {
    // Start with loading state
    container.innerHTML = `
      <div class="property-section">
        <h3>Recipe Layer</h3>
        <div style="padding: 20px; text-align: center;">
          <div class="loading-spinner"></div>
          <div>Loading recipes...</div>
        </div>
      </div>
    `;
    
    // Load recipes from database
    await this.loadRecipes();
    
    // Render the full UI
    this.renderPropertiesUI(container);
  }
  
  /**
   * Load recipes from database
   */
  private async loadRecipes(): Promise<void> {
    try {
      // Query recipes from database with model names via join
      const { data, error } = await supabase
        .from('recipes')
        .select(`
          *,
          roaster_model:training_jobs!recipes_roaster_model_id_fkey(job_name),
          bean_model:training_jobs!recipes_bean_model_id_fkey(job_name)
        `)
        .eq('user_id', this.user.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      // Process the joined data to extract model names
      // The join returns nested objects like { roaster_model: { job_name: 'name' } }
      const processedData = (data || []).map((recipe: any) => ({
        ...recipe,
        roaster_model_name: recipe.roaster_model?.job_name || 'Unknown',
        bean_model_name: recipe.bean_model?.job_name || 'Unknown'
      }));
      
      this.allRecipes = processedData as Recipe[];
      this.filteredRecipes = [...this.allRecipes];
    } catch (error) {
      console.error('Error loading recipes:', error);
      this.allRecipes = [];
      this.filteredRecipes = [];
    }
  }
  
  /**
   * Render the complete properties UI
   */
  private renderPropertiesUI(container: HTMLElement): void {
    container.innerHTML = `
      <div class="property-section">
        <div class="property-section-header">
          <h3>Layer Settings</h3>
          <button class="property-section-toggle" title="Collapse/Expand">▼</button>
        </div>
        <div class="property-section-content">
        
        <!-- Color picker -->
        <div class="property-group">
          <label class="property-label">Line Color</label>
          <div class="property-control">
            <input type="color" id="recipe-color-input" value="${this.config.color || '#3498db'}">
          </div>
        </div>
        
        <!-- Transparency slider -->
        <div class="property-group">
          <label class="property-label">Transparency</label>
          <div class="property-control">
            <input type="range" min="0" max="100" value="${(this.config.opacity || 1) * 100}" id="recipe-opacity-input">
          </div>
          <div class="property-value-display">
            <span id="recipe-opacity-value">${((this.config.opacity || 1) * 100).toFixed(0)}%</span>
          </div>
        </div>
        
        <!-- Data series toggles -->
        <div class="property-group">
          <label class="property-label">Show Data Series</label>
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="recipe-show-bt" ${this.config.showBeanTemp ? 'checked' : ''}>
              <span>Bean Temperature (BT)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="recipe-show-et" ${this.config.showEnvTemp ? 'checked' : ''}>
              <span>Environment Temperature (ET)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="recipe-show-ror" ${this.config.showRoR ? 'checked' : ''}>
              <span>Rate of Rise (RoR)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="recipe-show-heater" ${this.config.showHeater ? 'checked' : ''}>
              <span>Heater (scaled 0-100)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="recipe-show-fan" ${this.config.showFan ? 'checked' : ''}>
              <span>Fan (scaled 0-100)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="recipe-show-drum" ${this.config.showDrum ? 'checked' : ''}>
              <span>Drum (scaled 0-100)</span>
            </label>
          </div>
        </div>
        </div>
      </div>
      
      <div class="property-section">
        <div class="property-section-header">
          <h3>Filters</h3>
          <button class="property-section-toggle" title="Collapse/Expand">▼</button>
        </div>
        <div class="property-section-content">
        
        <!-- Filter controls -->
        <div class="property-group">
          <label class="property-label">Roaster Model</label>
          <div class="property-control">
            <input type="text" id="recipe-filter-roaster" placeholder="Filter by roaster model..." list="recipe-roaster-list">
            <datalist id="recipe-roaster-list"></datalist>
          </div>
        </div>
        
        <div class="property-group">
          <label class="property-label">Bean Model</label>
          <div class="property-control">
            <input type="text" id="recipe-filter-bean" placeholder="Filter by bean model..." list="recipe-bean-list">
            <datalist id="recipe-bean-list"></datalist>
          </div>
        </div>
        
        <div class="property-group">
          <button id="recipe-clear-filters" class="btn-secondary" style="width: 100%;">Clear Filters</button>
        </div>
        </div>
      </div>
      
      <div class="property-section">
        <div class="property-section-header">
          <h3>Select Recipe</h3>
          <button class="property-section-toggle" title="Collapse/Expand">▼</button>
        </div>
        <div class="property-section-content">
        <div style="font-size: 12px; color: #666; margin-bottom: 10px;">
          Click a recipe to preview and add it to the layer
        </div>
        
        <!-- Recipe table -->
        <div id="recipe-table-container" style="max-height: 400px; overflow-y: auto; overflow-x: auto; border: 1px solid #ddd; border-radius: 4px;">
          <table class="recipe-table" style="width: 100%; font-size: 12px;">
            <thead style="position: sticky; top: 0; background: #f5f5f5; z-index: 1;">
              <tr>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Name</th>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Roaster</th>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Bean</th>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Mass (g)</th>
              </tr>
            </thead>
            <tbody id="recipe-table-body">
            </tbody>
          </table>
        </div>
        
        <!-- Currently selected recipe display -->
        <div id="recipe-selected-recipe" style="margin-top: 10px; padding: 10px; background: #f0f0f0; border-radius: 4px; font-size: 12px; display: none;">
          <div style="font-weight: bold; margin-bottom: 4px;">Currently Selected:</div>
          <div id="recipe-selected-recipe-info"></div>
        </div>
        </div>
      </div>
    `;
    
    // Set up collapsible section handlers
    this.setupCollapsibleSections(container);
    
    // Populate filter options
    this.populateFilterOptions();
    
    // Render recipe table
    this.renderRecipeTable();
    
    // Attach event listeners
    this.attachEventListeners();
  }
  
  /**
   * Populate filter dropdowns with unique values
   */
  private populateFilterOptions(): void {
    // Extract unique values for roaster and bean models
    const roasterModels = new Set<string>();
    const beanModels = new Set<string>();
    
    this.allRecipes.forEach(recipe => {
      if ((recipe as any).roaster_model_name) roasterModels.add((recipe as any).roaster_model_name);
      if ((recipe as any).bean_model_name) beanModels.add((recipe as any).bean_model_name);
    });
    
    // Populate roaster model datalist
    const roasterList = document.getElementById('recipe-roaster-list');
    if (roasterList) {
      roasterList.innerHTML = '';
      Array.from(roasterModels).sort().forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        roasterList.appendChild(option);
      });
    }
    
    // Populate bean model datalist
    const beanList = document.getElementById('recipe-bean-list');
    if (beanList) {
      beanList.innerHTML = '';
      Array.from(beanModels).sort().forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        beanList.appendChild(option);
      });
    }
  }
  
  /**
   * Apply filters to recipes
   */
  private applyFilters(): void {
    const roasterFilter = (document.getElementById('recipe-filter-roaster') as HTMLInputElement)?.value.toLowerCase().trim() || '';
    const beanFilter = (document.getElementById('recipe-filter-bean') as HTMLInputElement)?.value.toLowerCase().trim() || '';
    
    this.filteredRecipes = this.allRecipes.filter(recipe => {
      const roasterName = ((recipe as any).roaster_model_name || '').toLowerCase();
      const beanName = ((recipe as any).bean_model_name || '').toLowerCase();
      
      if (roasterFilter && !roasterName.includes(roasterFilter)) return false;
      if (beanFilter && !beanName.includes(beanFilter)) return false;
      return true;
    });
    
    this.renderRecipeTable();
  }
  
  /**
   * Render the recipe selection table
   */
  private renderRecipeTable(): void {
    const tbody = document.getElementById('recipe-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    if (this.filteredRecipes.length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="4" style="text-align: center; padding: 20px; color: #999;">No recipes found</td>';
      tbody.appendChild(row);
      return;
    }
    
    this.filteredRecipes.forEach(recipe => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.dataset.recipeId = recipe.id;
      
      // Highlight if selected
      if (this.selectedRecipeId === recipe.id) {
        row.style.backgroundColor = '#e3f2fd';
      }
      
      row.innerHTML = `
        <td style="padding: 8px;">${recipe.name}</td>
        <td style="padding: 8px;">${(recipe as any).roaster_model_name || 'N/A'}</td>
        <td style="padding: 8px;">${(recipe as any).bean_model_name || 'N/A'}</td>
        <td style="padding: 8px;">${recipe.bean_mass_g}</td>
      `;
      
      // Add click handler
      row.addEventListener('click', () => this.selectRecipe(recipe.id));
      
      // Add hover effect
      row.addEventListener('mouseenter', () => {
        if (this.selectedRecipeId !== recipe.id) {
          row.style.backgroundColor = '#f5f5f5';
        }
      });
      row.addEventListener('mouseleave', () => {
        if (this.selectedRecipeId !== recipe.id) {
          row.style.backgroundColor = '';
        }
      });
      
      tbody.appendChild(row);
    });
  }
  
  /**
   * Select a recipe for display
   */
  private async selectRecipe(recipeId: string): Promise<void> {
    this.selectedRecipeId = recipeId;
    
    // Update config to include this recipe
    this.config.recipeId = recipeId;
    
    // Update table highlighting
    this.renderRecipeTable();
    
    // Update selected recipe display
    const recipe = this.allRecipes.find(r => r.id === recipeId);
    if (recipe) {
      const selectedRecipeDiv = document.getElementById('recipe-selected-recipe');
      const selectedRecipeInfo = document.getElementById('recipe-selected-recipe-info');
      if (selectedRecipeDiv && selectedRecipeInfo) {
        selectedRecipeDiv.style.display = 'block';
        selectedRecipeInfo.innerHTML = `
          <div><strong>${recipe.name}</strong></div>
          <div style="font-size: 11px; color: #666;">Roaster: ${(recipe as any).roaster_model_name || 'N/A'}</div>
          <div style="font-size: 11px; color: #666;">Bean: ${(recipe as any).bean_model_name || 'N/A'}</div>
          <div style="font-size: 11px; color: #666;">Mass: ${recipe.bean_mass_g}g</div>
        `;
      }
    }
    
    // Trigger chart update
    this.onConfigChange();
  }
  
  /**
   * Attach event listeners to property controls
   */
  private attachEventListeners(): void {
    // Color picker
    const colorInput = document.getElementById('recipe-color-input') as HTMLInputElement;
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        this.config.color = (e.target as HTMLInputElement).value;
        this.onConfigChange();
      });
    }
    
    // Opacity slider
    const opacityInput = document.getElementById('recipe-opacity-input') as HTMLInputElement;
    const opacityValue = document.getElementById('recipe-opacity-value');
    if (opacityInput && opacityValue) {
      opacityInput.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.opacity = value / 100;
        opacityValue.textContent = `${value}%`;
        this.onConfigChange();
      });
    }
    
    // Data series toggles
    const btCheckbox = document.getElementById('recipe-show-bt') as HTMLInputElement;
    if (btCheckbox) {
      btCheckbox.addEventListener('change', (e) => {
        this.config.showBeanTemp = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const etCheckbox = document.getElementById('recipe-show-et') as HTMLInputElement;
    if (etCheckbox) {
      etCheckbox.addEventListener('change', (e) => {
        this.config.showEnvTemp = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const rorCheckbox = document.getElementById('recipe-show-ror') as HTMLInputElement;
    if (rorCheckbox) {
      rorCheckbox.addEventListener('change', (e) => {
        this.config.showRoR = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const heaterCheckbox = document.getElementById('recipe-show-heater') as HTMLInputElement;
    if (heaterCheckbox) {
      heaterCheckbox.addEventListener('change', (e) => {
        this.config.showHeater = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const fanCheckbox = document.getElementById('recipe-show-fan') as HTMLInputElement;
    if (fanCheckbox) {
      fanCheckbox.addEventListener('change', (e) => {
        this.config.showFan = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const drumCheckbox = document.getElementById('recipe-show-drum') as HTMLInputElement;
    if (drumCheckbox) {
      drumCheckbox.addEventListener('change', (e) => {
        this.config.showDrum = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    // Filter inputs
    const filterRoaster = document.getElementById('recipe-filter-roaster');
    const filterBean = document.getElementById('recipe-filter-bean');
    
    if (filterRoaster) filterRoaster.addEventListener('input', () => this.applyFilters());
    if (filterBean) filterBean.addEventListener('input', () => this.applyFilters());
    
    // Clear filters button
    const clearFiltersBtn = document.getElementById('recipe-clear-filters');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        (document.getElementById('recipe-filter-roaster') as HTMLInputElement).value = '';
        (document.getElementById('recipe-filter-bean') as HTMLInputElement).value = '';
        this.applyFilters();
      });
    }
  }
  
  /**
   * Set up collapsible section handlers
   * Adds click handlers to toggle sections open/closed
   */
  private setupCollapsibleSections(container: HTMLElement): void {
    const sections = container.querySelectorAll('.property-section');
    
    sections.forEach(section => {
      const header = section.querySelector('.property-section-header');
      const toggle = section.querySelector('.property-section-toggle');
      
      if (header && toggle) {
        header.addEventListener('click', () => {
          section.classList.toggle('collapsed');
        });
      }
    });
  }
  
  /**
   * Get data series for this layer
   * @returns Array of data series to plot
   */
  async getDataSeries(): Promise<DataSeries[]> {
    const series: DataSeries[] = [];
    
    // If no recipe selected, return empty
    if (!this.config.recipeId) {
      return series;
    }
    
    // Get the selected recipe
    const recipe = this.allRecipes.find(r => r.id === this.config.recipeId);
    if (!recipe) return series;
    
    try {
      // Recipe data is already available from allRecipes
      const data = recipe;
      
      // Time array (already in seconds from recipe data)
      const timeSeconds = data.simulated_results.time;
      
      // Calculate RoR if needed
      // RoR is the derivative of bean temperature with respect to time
      // Expressed in °C/min
      let ror: number[] = [];
      if (this.config.showRoR) {
        for (let i = 1; i < data.simulated_results.bean_temp.length; i++) {
          const dt = timeSeconds[i] - timeSeconds[i - 1]; // seconds
          const dTemp = data.simulated_results.bean_temp[i] - data.simulated_results.bean_temp[i - 1]; // °C
          const rorValue = (dTemp / dt) * 60; // Convert to °C/min
          ror.push(rorValue);
        }
      }
      
      // Base color for this layer
      const baseColor = this.config.color || '#3498db';
      
      // Bean temperature trace (bean_temp is the bean probe temperature)
      if (this.config.showBeanTemp) {
        series.push({
          label: `BT - ${recipe.name}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.simulated_results.bean_temp[i] })),
          style: {
            color: baseColor,
            lineWidth: 2,
            showPoints: false,
            pointRadius: 0,
            lineDash: [],
            fill: false,
            fillOpacity: 0
          },
          yAxisID: 'y'
        });
      }
      
      // Environment temperature trace (env_probe_temp is equivalent to ET)
      if (this.config.showEnvTemp) {
        series.push({
          label: `ET - ${recipe.name}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.simulated_results.env_probe_temp[i] })),
          style: {
            color: baseColor,
            lineWidth: 1.5,
            showPoints: false,
            pointRadius: 0,
            lineDash: [5, 5], // Dashed line
            fill: false,
            fillOpacity: 0
          },
          yAxisID: 'y'
        });
      }
      
      // Rate of rise trace (plotted on right-hand y-axis, only positive values)
      if (this.config.showRoR && ror.length > 0) {
        // RoR data structure: map time to RoR, filtering out negative values
        // Note: RoR array is one element shorter than time array (starts at index 1)
        const rorData = timeSeconds
          .slice(1) // Skip first time point since RoR starts at index 1
          .map((t, i) => ({ x: t, y: ror[i] }))
          .filter(point => point.y >= 0); // Only positive RoR values
        
        series.push({
          label: `RoR - ${recipe.name}`,
          data: rorData,
          style: {
            color: baseColor,
            lineWidth: 1.5,
            showPoints: false,
            pointRadius: 0,
            lineDash: [2, 2], // Dotted line
            fill: false,
            fillOpacity: 0
          },
          yAxisID: 'y2' // Plot on right-hand axis
        });
      }
      
      // Control traces (scaled to 0-100 range)
      // Recipe control profiles are stored as discrete events with their own time arrays
      // Control values are stored in 0-1 range, need to convert to 0-100
      
      if (this.config.showHeater) {
        // Convert control profile to continuous time series using step function
        // For each time point in simulated_results, find the most recent control value
        const heaterData = timeSeconds.map(t => {
          // Find the last control point that occurred at or before this time
          let value = 0; // Default to 0 if no control point yet
          for (let i = 0; i < data.control_profile.heater.time.length; i++) {
            if (data.control_profile.heater.time[i] <= t) {
              value = data.control_profile.heater.values[i];
            } else {
              break;
            }
          }
          return { x: t, y: value * 100 }; // Convert 0-1 to 0-100
        });
        
        series.push({
          label: `Heater - ${recipe.name}`,
          data: heaterData,
          style: {
            color: '#FF4444', // Red for heater
            lineWidth: 1.5,
            showPoints: false,
            pointRadius: 0,
            lineDash: [],
            fill: false,
            fillOpacity: 0
          },
          yAxisID: 'y'
        });
      }
      
      if (this.config.showFan) {
        // Convert control profile to continuous time series using step function
        const fanData = timeSeconds.map(t => {
          let value = 0;
          for (let i = 0; i < data.control_profile.fan.time.length; i++) {
            if (data.control_profile.fan.time[i] <= t) {
              value = data.control_profile.fan.values[i];
            } else {
              break;
            }
          }
          return { x: t, y: value * 100 };
        });
        
        series.push({
          label: `Fan - ${recipe.name}`,
          data: fanData,
          style: {
            color: '#4444FF', // Blue for fan
            lineWidth: 1.5,
            showPoints: false,
            pointRadius: 0,
            lineDash: [],
            fill: false,
            fillOpacity: 0
          },
          yAxisID: 'y'
        });
      }
      
      if (this.config.showDrum) {
        // Convert control profile to continuous time series using step function
        const drumData = timeSeconds.map(t => {
          let value = 0;
          for (let i = 0; i < data.control_profile.drum.time.length; i++) {
            if (data.control_profile.drum.time[i] <= t) {
              value = data.control_profile.drum.values[i];
            } else {
              break;
            }
          }
          return { x: t, y: value * 100 };
        });
        
        series.push({
          label: `Drum - ${recipe.name}`,
          data: drumData,
          style: {
            color: '#888888', // Gray for drum
            lineWidth: 1.5,
            showPoints: false,
            pointRadius: 0,
            lineDash: [3, 3], // Dashed
            fill: false,
            fillOpacity: 0
          },
          yAxisID: 'y'
        });
      }
      
    } catch (error) {
      console.error('Error loading recipe data:', error);
    }
    
    return series;
  }
}
