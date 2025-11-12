/**
 * Recipe Visualizer Module
 * 
 * This module provides a visualizer for browsing and comparing saved recipes.
 * It's essentially a copy of the roast history functionality adapted for recipes.
 * 
 * Key features:
 * - Load recipes from database
 * - Display recipes in a table
 * - Visualize selected recipes with temperature and control charts
 * - Support multi-recipe comparison
 */

import { supabase } from '../../lib/supabase';
import { generateAlogFile, downloadAlogFile } from '../../data/alogGenerator';
import { Chart, registerables } from 'chart.js';

// Register Chart.js components
Chart.register(...registerables);

/**
 * Recipe data structure stored in database
 * Each recipe contains the control profile and simulated results
 */
interface Recipe {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  duration_seconds: number;
  bean_mass_g: number;
  ambient_temp_c: number;
  roaster_model_id: string;
  bean_model_id: string;
  // Model names fetched via join
  roaster_model_name?: string;
  bean_model_name?: string;
  // Control profiles: each control has its own time array (discrete events)
  control_profile: {
    heater: {
      time: number[];      // Time points for heater changes (seconds)
      values: number[];    // Heater power values (0-1) at each time point
    };
    fan: {
      time: number[];      // Time points for fan changes (seconds)
      values: number[];    // Fan speed values (0-1) at each time point
    };
    drum: {
      time: number[];      // Time points for drum changes (seconds)
      values: number[];    // Drum speed values (0-1) at each time point
    };
  };
  // Simulated results are the predicted temperature profiles
  simulated_results: {
    time: number[];                // Time in seconds
    bean_temp: number[];           // Bean probe temperature (°C)
    bean_surface_temp: number[];   // Bean surface temperature (°C)
    drum_temp: number[];           // Drum temperature (°C)
    air_temp: number[];            // Air temperature (°C)
    env_probe_temp: number[];      // Environment probe temperature (°C)
  };
  target_temp_c: number | null;    // Optional: target final bean temp
}

/**
 * RecipeVisualizer class manages the recipe browser and visualization
 */
export class RecipeVisualizer {
  private recipes: Recipe[] = [];
  private selectedRecipeIds: Set<string> = new Set();
  private combinedChart: any = null;  // Chart.js instance for the combined chart
  
  // DOM elements
  private readonly loadingDiv: HTMLDivElement;
  private readonly emptyDiv: HTMLDivElement;
  private readonly tableContainer: HTMLDivElement;
  private readonly tableBody: HTMLTableSectionElement;
  private readonly selectAllCheckbox: HTMLInputElement;
  private readonly visualizeBtn: HTMLButtonElement;
  private readonly selectionCount: HTMLSpanElement;
  
  // Visualization panel elements
  private readonly vizPanelTitle: HTMLHeadingElement;
  private readonly vizPanelLoading: HTMLDivElement;
  private readonly vizPanelCharts: HTMLDivElement;
  private readonly vizPanelEmpty: HTMLDivElement;
  
  constructor() {
    console.log('Initializing Recipe Visualizer...');
    
    // Get DOM elements
    this.loadingDiv = document.getElementById('recipe-loading') as HTMLDivElement;
    this.emptyDiv = document.getElementById('recipe-empty') as HTMLDivElement;
    this.tableContainer = document.getElementById('recipe-table-container') as HTMLDivElement;
    this.tableBody = document.getElementById('recipe-table-body') as HTMLTableSectionElement;
    this.selectAllCheckbox = document.getElementById('recipe-select-all') as HTMLInputElement;
    this.visualizeBtn = document.getElementById('recipe-visualize-selected') as HTMLButtonElement;
    this.selectionCount = document.getElementById('recipe-selection-count') as HTMLSpanElement;
    
    this.vizPanelTitle = document.getElementById('recipe-viz-panel-title') as HTMLHeadingElement;
    this.vizPanelLoading = document.getElementById('recipe-viz-panel-loading') as HTMLDivElement;
    this.vizPanelCharts = document.getElementById('recipe-viz-panel-charts') as HTMLDivElement;
    this.vizPanelEmpty = document.getElementById('recipe-viz-panel-empty') as HTMLDivElement;
    
    this.initializeUI();
    this.loadRecipes();
  }
  
  /**
   * Initialize UI event listeners
   */
  private initializeUI(): void {
    // Select all checkbox
    if (this.selectAllCheckbox) {
      this.selectAllCheckbox.addEventListener('change', (e) => {
        const checked = (e.target as HTMLInputElement).checked;
        this.selectAllRecipes(checked);
      });
    }
    
    // Visualize selected button
    if (this.visualizeBtn) {
      this.visualizeBtn.addEventListener('click', () => {
        this.visualizeSelected();
      });
    }
  }
  
  /**
   * Load recipes from database
   */
  private async loadRecipes(): Promise<void> {
    try {
      this.loadingDiv.style.display = 'block';
      this.emptyDiv.style.display = 'none';
      this.tableContainer.style.display = 'none';
      
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      
      // Query recipes from database with model names via join
      // We fetch the job_name from training_jobs for both roaster and bean models
      const { data, error } = await supabase
        .from('recipes')
        .select(`
          *,
          roaster_model:training_jobs!recipes_roaster_model_id_fkey(job_name),
          bean_model:training_jobs!recipes_bean_model_id_fkey(job_name)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      // Process the joined data to extract model names
      // The join returns nested objects like { roaster_model: { job_name: 'name' } }
      const processedData = (data || []).map((recipe: any) => ({
        ...recipe,
        roaster_model_name: recipe.roaster_model?.job_name || 'Unknown',
        bean_model_name: recipe.bean_model?.job_name || 'Unknown'
      }));
      
      this.recipes = processedData as Recipe[];
      
      this.loadingDiv.style.display = 'none';
      
      if (this.recipes.length === 0) {
        this.emptyDiv.style.display = 'block';
      } else {
        this.tableContainer.style.display = 'block';
        this.renderRecipesTable();
      }
      
    } catch (error) {
      console.error('Failed to load recipes:', error);
      this.loadingDiv.style.display = 'none';
      this.emptyDiv.style.display = 'block';
      
      // Show error message to user
      const messageDiv = document.getElementById('message');
      if (messageDiv) {
        messageDiv.textContent = `Failed to load recipes: ${(error as Error).message}`;
        messageDiv.className = 'message error';
        messageDiv.style.display = 'block';
      }
    }
  }
  
  /**
   * Render recipes table
   */
  private renderRecipesTable(): void {
    this.tableBody.innerHTML = '';
    
    this.recipes.forEach(recipe => {
      const row = this.createRecipeRow(recipe);
      this.tableBody.appendChild(row);
    });
  }
  
  /**
   * Create a table row for a recipe
   * @param recipe - The recipe to create a row for
   * @returns HTMLTableRowElement
   */
  private createRecipeRow(recipe: Recipe): HTMLTableRowElement {
    const row = document.createElement('tr');
    
    // Checkbox
    const checkboxCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.recipeId = recipe.id;
    checkbox.addEventListener('change', () => this.handleRecipeSelection(recipe.id, checkbox.checked));
    checkboxCell.appendChild(checkbox);
    row.appendChild(checkboxCell);
    
    // Name
    const nameCell = document.createElement('td');
    nameCell.textContent = recipe.name;
    row.appendChild(nameCell);
    
    // Created date
    const createdCell = document.createElement('td');
    createdCell.textContent = new Date(recipe.created_at).toLocaleDateString();
    row.appendChild(createdCell);
    
    // Duration
    const durationCell = document.createElement('td');
    const minutes = Math.floor(recipe.duration_seconds / 60);
    const seconds = recipe.duration_seconds % 60;
    durationCell.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    row.appendChild(durationCell);
    
    // Target temp
    const targetTempCell = document.createElement('td');
    targetTempCell.textContent = recipe.target_temp_c ? `${recipe.target_temp_c.toFixed(1)}°C` : 'N/A';
    row.appendChild(targetTempCell);
    
    // Bean mass
    const massCell = document.createElement('td');
    massCell.textContent = `${recipe.bean_mass_g}g`;
    row.appendChild(massCell);
    
    // Ambient temperature
    const ambientTempCell = document.createElement('td');
    ambientTempCell.textContent = `${recipe.ambient_temp_c}°C`;
    row.appendChild(ambientTempCell);
    
    // Roaster model name
    const roasterModelCell = document.createElement('td');
    roasterModelCell.textContent = recipe.roaster_model_name || 'Unknown';
    roasterModelCell.title = `Model ID: ${recipe.roaster_model_id.slice(0, 8)}...`;
    row.appendChild(roasterModelCell);
    
    // Bean model name
    const beanModelCell = document.createElement('td');
    beanModelCell.textContent = recipe.bean_model_name || 'Unknown';
    beanModelCell.title = `Model ID: ${recipe.bean_model_id.slice(0, 8)}...`;
    row.appendChild(beanModelCell);
    
    // Actions
    const actionsCell = document.createElement('td');
    
    const visualizeBtn = document.createElement('button');
    visualizeBtn.textContent = '📊 View';
    visualizeBtn.className = 'btn-edit';
    visualizeBtn.addEventListener('click', () => this.visualizeRecipe(recipe.id));
    actionsCell.appendChild(visualizeBtn);
    
    const downloadBtn = document.createElement('button');
    downloadBtn.textContent = '⬇️ .alog';
    downloadBtn.className = 'btn-download';
    downloadBtn.title = 'Download as Artisan .alog file';
    downloadBtn.addEventListener('click', () => this.downloadRecipeAsAlog(recipe.id));
    actionsCell.appendChild(downloadBtn);
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑 Delete';
    deleteBtn.className = 'btn-delete';
    deleteBtn.addEventListener('click', () => this.deleteRecipe(recipe.id));
    actionsCell.appendChild(deleteBtn);
    
    row.appendChild(actionsCell);
    
    return row;
  }
  
  /**
   * Handle recipe selection checkbox change
   * @param recipeId - ID of the recipe
   * @param selected - Whether the recipe is selected
   */
  private handleRecipeSelection(recipeId: string, selected: boolean): void {
    if (selected) {
      this.selectedRecipeIds.add(recipeId);
    } else {
      this.selectedRecipeIds.delete(recipeId);
    }
    
    // Update UI
    this.updateSelectionUI();
  }
  
  /**
   * Select or deselect all recipes
   * @param selected - Whether to select all
   */
  private selectAllRecipes(selected: boolean): void {
    this.selectedRecipeIds.clear();
    
    if (selected) {
      this.recipes.forEach(recipe => this.selectedRecipeIds.add(recipe.id));
    }
    
    // Update checkboxes
    const checkboxes = this.tableBody.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
      (cb as HTMLInputElement).checked = selected;
    });
    
    this.updateSelectionUI();
  }
  
  /**
   * Update selection UI (count and button visibility)
   */
  private updateSelectionUI(): void {
    const count = this.selectedRecipeIds.size;
    this.selectionCount.textContent = count.toString();
    this.visualizeBtn.style.display = count > 0 ? 'inline-block' : 'none';
  }
  
  /**
   * Visualize a single recipe
   * @param recipeId - ID of the recipe to visualize
   */
  private visualizeRecipe(recipeId: string): void {
    this.selectedRecipeIds.clear();
    this.selectedRecipeIds.add(recipeId);
    this.visualizeSelected();
  }
  
  /**
   * Visualize selected recipes
   */
  private visualizeSelected(): void {
    if (this.selectedRecipeIds.size === 0) return;
    
    // Get selected recipes
    const selectedRecipes = this.recipes.filter(r => this.selectedRecipeIds.has(r.id));
    
    // Update title
    if (selectedRecipes.length === 1) {
      this.vizPanelTitle.textContent = `Recipe: ${selectedRecipes[0].name}`;
    } else {
      this.vizPanelTitle.textContent = `Comparing ${selectedRecipes.length} Recipes`;
    }
    
    // Show loading, hide others
    this.vizPanelEmpty.style.display = 'none';
    this.vizPanelCharts.style.display = 'none';
    this.vizPanelLoading.style.display = 'block';
    
    // Render charts
    setTimeout(() => {
      this.renderCharts(selectedRecipes);
      this.vizPanelLoading.style.display = 'none';
      this.vizPanelCharts.style.display = 'flex';
    }, 100);
  }
  
  /**
   * Render combined temperature and control chart for selected recipes using Chart.js
   * Temperature traces (higher values up to 350C) are shown on the primary axis
   * Control traces (0-100 scale) are shown on the same chart below the temperature traces
   * @param recipes - Array of recipes to visualize
   */
  private renderCharts(recipes: Recipe[]): void {
    // Get the canvas element from the HTML
    const canvas = document.getElementById('recipe-combined-chart') as HTMLCanvasElement;
    if (!canvas) {
      console.error('Canvas element not found');
      return;
    }
    
    // Destroy existing chart if it exists to prevent memory leaks
    if (this.combinedChart) {
      this.combinedChart.destroy();
    }
    
    // Prepare datasets for Chart.js
    // We'll combine both temperature and control data in a single chart
    const datasets: any[] = [];
    
    // Add temperature datasets for each recipe
    recipes.forEach((recipe, idx) => {
      const baseColor = this.getColorForIndex(idx);
      
      // Bean probe temperature (solid line, primary data)
      datasets.push({
        label: `${recipe.name} - Bean Probe`,
        data: recipe.simulated_results.time.map((t, i) => ({
          x: t,
          y: recipe.simulated_results.bean_temp[i]
        })),
        borderColor: baseColor,
        backgroundColor: baseColor,
        borderWidth: 2,
        pointRadius: 0,  // No points, just lines for cleaner look
        tension: 0.1,  // Slight curve for smoother lines
        fill: false,
        yAxisID: 'y'
      });
      
      // Calculate Rate of Rise (RoR) - derivative of bean temperature
      // RoR is expressed in °C/min
      const rorData: {x: number, y: number}[] = [];
      for (let i = 1; i < recipe.simulated_results.time.length; i++) {
        const dt = recipe.simulated_results.time[i] - recipe.simulated_results.time[i-1]; // seconds
        const dTemp = recipe.simulated_results.bean_temp[i] - recipe.simulated_results.bean_temp[i-1]; // °C
        const ror = (dTemp / dt) * 60; // Convert to °C/min
        rorData.push({
          x: recipe.simulated_results.time[i],
          y: ror
        });
      }
      
      // Rate of Rise (dotted line) - uses right y-axis
      datasets.push({
        label: `${recipe.name} - RoR`,
        data: rorData,
        borderColor: this.adjustColorOpacity(baseColor, 0.6),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.6),
        borderWidth: 1.5,
        borderDash: [2, 2],  // Dotted line pattern
        pointRadius: 0,
        tension: 0.2,  // Smooth the RoR curve
        fill: false,
        yAxisID: 'y2'  // Use right y-axis for RoR
      });
      
      // Bean surface temperature (dashed line, secondary data)
      datasets.push({
        label: `${recipe.name} - Bean Surface`,
        data: recipe.simulated_results.time.map((t, i) => ({
          x: t,
          y: recipe.simulated_results.bean_surface_temp[i]
        })),
        borderColor: baseColor,
        backgroundColor: baseColor,
        borderWidth: 1,
        borderDash: [5, 5],  // Dashed line pattern
        pointRadius: 0,
        tension: 0.1,
        fill: false,
        yAxisID: 'y'
      });
      
      // Drum temperature (dotted line)
      datasets.push({
        label: `${recipe.name} - Drum`,
        data: recipe.simulated_results.time.map((t, i) => ({
          x: t,
          y: recipe.simulated_results.drum_temp[i]
        })),
        borderColor: this.adjustColorOpacity(baseColor, 0.8),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.8),
        borderWidth: 1,
        borderDash: [3, 3],  // Dotted line pattern
        pointRadius: 0,
        tension: 0.1,
        fill: false,
        yAxisID: 'y'
      });
      
      // Air temperature (dash-dot line)
      datasets.push({
        label: `${recipe.name} - Air`,
        data: recipe.simulated_results.time.map((t, i) => ({
          x: t,
          y: recipe.simulated_results.air_temp[i]
        })),
        borderColor: this.adjustColorOpacity(baseColor, 0.7),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.7),
        borderWidth: 1,
        borderDash: [8, 3, 2, 3],  // Dash-dot pattern
        pointRadius: 0,
        tension: 0.1,
        fill: false,
        yAxisID: 'y'
      });
      
      // Environment probe temperature (long dash line)
      datasets.push({
        label: `${recipe.name} - Env Probe`,
        data: recipe.simulated_results.time.map((t, i) => ({
          x: t,
          y: recipe.simulated_results.env_probe_temp[i]
        })),
        borderColor: this.adjustColorOpacity(baseColor, 0.6),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.6),
        borderWidth: 1,
        borderDash: [10, 5],  // Long dash pattern
        pointRadius: 0,
        tension: 0.1,
        fill: false,
        yAxisID: 'y'
      });
    });
    
    // Add control datasets for each recipe (heater, fan, and drum)
    // These are on 0-100 scale and will appear below temperature traces
    recipes.forEach((recipe, idx) => {
      const baseColor = this.getColorForIndex(idx);
      
      // Heater control (solid line, piecewise constant/step function)
      // Controls are stored as discrete events with their own time arrays
      datasets.push({
        label: `${recipe.name} - Heater`,
        data: recipe.control_profile.heater.time.map((t, i) => ({
          x: t,
          y: recipe.control_profile.heater.values[i] * 100  // Convert 0-1 to 0-100%
        })),
        borderColor: this.adjustColorOpacity(baseColor, 0.7),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.7),
        borderWidth: 2,
        pointRadius: 0,
        stepped: 'before',  // Step function: value changes AT the control point
        fill: false
      });
      
      // Fan control (dashed line, piecewise constant/step function)
      // Controls are stored as discrete events with their own time arrays
      datasets.push({
        label: `${recipe.name} - Fan`,
        data: recipe.control_profile.fan.time.map((t, i) => ({
          x: t,
          y: recipe.control_profile.fan.values[i] * 100  // Convert 0-1 to 0-100%
        })),
        borderColor: this.adjustColorOpacity(baseColor, 0.7),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.7),
        borderWidth: 2,
        borderDash: [5, 5],  // Dashed line pattern
        pointRadius: 0,
        stepped: 'before',  // Step function: value changes AT the control point
        fill: false
      });
      
      // Drum control (dotted line, piecewise constant/step function)
      // Controls are stored as discrete events with their own time arrays
      datasets.push({
        label: `${recipe.name} - Drum`,
        data: recipe.control_profile.drum.time.map((t, i) => ({
          x: t,
          y: recipe.control_profile.drum.values[i] * 100  // Convert 0-1 to 0-100%
        })),
        borderColor: this.adjustColorOpacity(baseColor, 0.7),
        backgroundColor: this.adjustColorOpacity(baseColor, 0.7),
        borderWidth: 2,
        borderDash: [2, 2],  // Dotted line pattern (different from fan's dashed)
        pointRadius: 0,
        stepped: 'before',  // Step function: value changes AT the control point
        fill: false
      });
    });
    
    // Create the combined Chart.js chart
    this.combinedChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: datasets
      },
      options: {
        animation: false,  // Disable animations for instant updates
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false
        },
        plugins: {
          title: {
            display: true,
            text: 'Recipe Profile - Temperature & Controls',
            font: {
              size: 16
            }
          },
          legend: {
            display: true,
            position: 'right',
            labels: {
              usePointStyle: true,
              boxWidth: 6
            }
          },
          tooltip: {
            callbacks: {
              label: function(context: any) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                // Check if this is RoR, control, or temperature
                if (label.includes('RoR')) {
                  label += context.parsed.y.toFixed(1) + ' °C/min';
                } else if (label.includes('Heater') || label.includes('Fan') || label.includes('Drum')) {
                  label += context.parsed.y.toFixed(1) + '%';
                } else {
                  label += context.parsed.y.toFixed(1) + '°C';
                }
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            position: 'bottom',
            title: {
              display: true,
              text: 'Time (seconds)'
            }
          },
          y: {
            type: 'linear',
            position: 'left',
            title: {
              display: true,
              text: 'Temperature (°C) / Control (%)'
            },
            // Y-axis accommodates both temperature (up to ~350°C) and control (0-100%)
            // Controls will naturally appear at the bottom due to their lower values
            min: 0,
            max: 350
          },
          y2: {
            type: 'linear',
            position: 'right',
            title: {
              display: true,
              text: 'RoR (°C/min)'
            },
            min: 0,
            max: 50,  // Typical RoR range for coffee roasting
            grid: {
              drawOnChartArea: false  // Don't draw gridlines for right axis
            }
          }
        }
      }
    });
  }
  
  /**
   * Adjust color opacity for better visual distinction
   * This is used to make control traces slightly more transparent than temperature traces
   * @param color - Hex color string (e.g., '#e74c3c')
   * @param opacity - Opacity value between 0 and 1
   * @returns RGBA color string
   */
  private adjustColorOpacity(color: string, opacity: number): string {
    // Convert hex to RGB
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }
  
  /**
   * Get a color for a given index (for multi-recipe comparison)
   * @param idx - Index of the recipe
   * @returns Color string
   */
  private getColorForIndex(idx: number): string {
    const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
    return colors[idx % colors.length];
  }
  
  /**
   * Download recipe as Artisan .alog file
   * 
   * Converts the recipe data to .alog format and triggers a download.
   * This allows users to import their AutoRoaster recipes into Artisan software.
   * 
   * @param recipeId - ID of the recipe to download
   */
  private downloadRecipeAsAlog(recipeId: string): void {
    // Find the recipe in our loaded recipes array
    const recipe = this.recipes.find(r => r.id === recipeId);
    
    if (!recipe) {
      console.error('Recipe not found:', recipeId);
      alert('Recipe not found. Please try refreshing the page.');
      return;
    }
    
    try {
      // Generate .alog file content from recipe data
      const alogContent = generateAlogFile(recipe);
      
      // Trigger download with recipe name as filename
      downloadAlogFile(alogContent, recipe.name);
      
      console.log(`Downloaded recipe "${recipe.name}" as .alog file`);
      
    } catch (error) {
      console.error('Failed to generate .alog file:', error);
      alert(`Failed to generate .alog file: ${(error as Error).message}`);
    }
  }
  
  /**
   * Delete a recipe
   * @param recipeId - ID of the recipe to delete
   */
  private async deleteRecipe(recipeId: string): Promise<void> {
    if (!confirm('Are you sure you want to delete this recipe?')) {
      return;
    }
    
    try {
      const { error } = await supabase
        .from('recipes')
        .delete()
        .eq('id', recipeId);
      
      if (error) throw error;
      
      // Reload recipes
      await this.loadRecipes();
      
      // Clear visualization if deleted recipe was selected
      if (this.selectedRecipeIds.has(recipeId)) {
        this.selectedRecipeIds.delete(recipeId);
        this.vizPanelEmpty.style.display = 'block';
        this.vizPanelCharts.style.display = 'none';
      }
      
    } catch (error) {
      console.error('Failed to delete recipe:', error);
      alert(`Failed to delete recipe: ${(error as Error).message}`);
    }
  }
}
