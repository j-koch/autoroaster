/**
 * Historical Layer Implementation
 * 
 * Manages historical roast data visualization in the Canvas.
 * Provides:
 * - Roast filtering and selection table (similar to dashboard)
 * - Live preview of selected roasts
 * - Color and transparency controls
 * - Toggle visibility for ET, BT, RoR, and control inputs
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import { parseAlogFile, calculateRateOfRise, type ParsedRoastData } from '../../data/alogParser';
import type { HistoricalLayerConfig, DataSeries, Roast } from './types';

/**
 * HistoricalLayer class
 * Handles all historical roast layer operations
 */
export class HistoricalLayer {
  private user: User;
  private config: HistoricalLayerConfig;
  private allRoasts: Roast[] = [];
  private filteredRoasts: Roast[] = [];
  private selectedRoastId: string | null = null;
  
  // Cache for parsed roast data to avoid re-fetching
  private roastDataCache: Map<string, ParsedRoastData> = new Map();
  
  // Callback for when configuration changes (to trigger chart update)
  private onConfigChange: () => void;
  
  constructor(user: User, config: HistoricalLayerConfig, onConfigChange: () => void) {
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
        <h3>Historical Roast Layer</h3>
        <div style="padding: 20px; text-align: center;">
          <div class="loading-spinner"></div>
          <div>Loading roasts...</div>
        </div>
      </div>
    `;
    
    // Load roasts from database
    await this.loadRoasts();
    
    // Render the full UI
    this.renderPropertiesUI(container);
  }
  
  /**
   * Load roasts from database
   */
  private async loadRoasts(): Promise<void> {
    try {
      const { data: roasts, error } = await supabase
        .from('roasts')
        .select('*')
        .eq('user_id', this.user.id)
        .order('upload_date', { ascending: false });
      
      if (error) throw error;
      
      this.allRoasts = (roasts as Roast[]) || [];
      this.filteredRoasts = [...this.allRoasts];
    } catch (error) {
      console.error('Error loading roasts:', error);
      this.allRoasts = [];
      this.filteredRoasts = [];
    }
  }
  
  /**
   * Render the complete properties UI
   */
  private renderPropertiesUI(container: HTMLElement): void {
    container.innerHTML = `
      <div class="property-section">
        <h3>Layer Settings</h3>
        
        <!-- Color picker -->
        <div class="property-group">
          <label class="property-label">Line Color</label>
          <div class="property-control">
            <input type="color" id="hist-color-input" value="${this.config.color || '#e74c3c'}">
          </div>
        </div>
        
        <!-- Transparency slider -->
        <div class="property-group">
          <label class="property-label">Transparency</label>
          <div class="property-control">
            <input type="range" min="0" max="100" value="${(this.config.opacity || 1) * 100}" id="hist-opacity-input">
          </div>
          <div class="property-value-display">
            <span id="hist-opacity-value">${((this.config.opacity || 1) * 100).toFixed(0)}%</span>
          </div>
        </div>
        
        <!-- Data series toggles -->
        <div class="property-group">
          <label class="property-label">Show Data Series</label>
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-show-bt" ${this.config.showBeanTemp ? 'checked' : ''}>
              <span>Bean Temperature (BT)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-show-et" ${this.config.showEnvTemp ? 'checked' : ''}>
              <span>Environment Temperature (ET)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-show-ror" ${this.config.showRoR ? 'checked' : ''}>
              <span>Rate of Rise (RoR)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-show-heater" ${this.config.showHeater ? 'checked' : ''}>
              <span>Heater (scaled 0-100)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-show-fan" ${this.config.showFan ? 'checked' : ''}>
              <span>Fan (scaled 0-100)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-show-drum" ${this.config.showDrum ? 'checked' : ''}>
              <span>Drum (scaled 0-100)</span>
            </label>
          </div>
        </div>
        
        <!-- Time alignment option -->
        <div class="property-group">
          <label class="property-label">Time Alignment</label>
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="hist-align-charge" ${this.config.alignAtCharge ? 'checked' : ''}>
              <span>Align at Charge Event (t=0)</span>
            </label>
          </div>
        </div>
      </div>
      
      <div class="property-section">
        <h3>Filters</h3>
        
        <!-- Filter controls -->
        <div class="property-group">
          <label class="property-label">Origin</label>
          <div class="property-control">
            <input type="text" id="hist-filter-origin" placeholder="Filter by origin..." list="hist-origin-list">
            <datalist id="hist-origin-list"></datalist>
          </div>
        </div>
        
        <div class="property-group">
          <label class="property-label">Variety</label>
          <div class="property-control">
            <input type="text" id="hist-filter-variety" placeholder="Filter by variety..." list="hist-variety-list">
            <datalist id="hist-variety-list"></datalist>
          </div>
        </div>
        
        <div class="property-group">
          <label class="property-label">Roaster</label>
          <div class="property-control">
            <input type="text" id="hist-filter-roaster" placeholder="Filter by roaster..." list="hist-roaster-list">
            <datalist id="hist-roaster-list"></datalist>
          </div>
        </div>
        
        <div class="property-group">
          <label class="property-label">Process</label>
          <div class="property-control">
            <select id="hist-filter-process">
              <option value="">All processes</option>
            </select>
          </div>
        </div>
        
        <div class="property-group">
          <button id="hist-clear-filters" class="btn-secondary" style="width: 100%;">Clear Filters</button>
        </div>
      </div>
      
      <div class="property-section">
        <h3>Select Roast</h3>
        <div style="font-size: 12px; color: #666; margin-bottom: 10px;">
          Click a roast to preview and add it to the layer
        </div>
        
        <!-- Roast table -->
        <div id="hist-roast-table-container" style="max-height: 400px; overflow-y: auto; overflow-x: auto; border: 1px solid #ddd; border-radius: 4px;">
          <table class="hist-roast-table" style="width: 100%; font-size: 12px;">
            <thead style="position: sticky; top: 0; background: #f5f5f5; z-index: 1;">
              <tr>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Date</th>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Origin</th>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Variety</th>
                <th style="padding: 8px; text-align: left; white-space: nowrap;">Batch (g)</th>
              </tr>
            </thead>
            <tbody id="hist-roast-table-body">
            </tbody>
          </table>
        </div>
        
        <!-- Currently selected roast display -->
        <div id="hist-selected-roast" style="margin-top: 10px; padding: 10px; background: #f0f0f0; border-radius: 4px; font-size: 12px; display: none;">
          <div style="font-weight: bold; margin-bottom: 4px;">Currently Selected:</div>
          <div id="hist-selected-roast-info"></div>
        </div>
      </div>
    `;
    
    // Populate filter options
    this.populateFilterOptions();
    
    // Render roast table
    this.renderRoastTable();
    
    // Attach event listeners
    this.attachEventListeners();
  }
  
  /**
   * Populate filter dropdowns with unique values
   */
  private populateFilterOptions(): void {
    // Extract unique values
    const origins = new Set<string>();
    const varieties = new Set<string>();
    const roasters = new Set<string>();
    const processes = new Set<string>();
    
    this.allRoasts.forEach(roast => {
      if (roast.origin) origins.add(roast.origin);
      if (roast.variety) varieties.add(roast.variety);
      if (roast.roaster) roasters.add(roast.roaster);
      if (roast.process) processes.add(roast.process);
    });
    
    // Populate datalists
    const originList = document.getElementById('hist-origin-list');
    if (originList) {
      originList.innerHTML = '';
      Array.from(origins).sort().forEach(origin => {
        const option = document.createElement('option');
        option.value = origin;
        originList.appendChild(option);
      });
    }
    
    const varietyList = document.getElementById('hist-variety-list');
    if (varietyList) {
      varietyList.innerHTML = '';
      Array.from(varieties).sort().forEach(variety => {
        const option = document.createElement('option');
        option.value = variety;
        varietyList.appendChild(option);
      });
    }
    
    const roasterList = document.getElementById('hist-roaster-list');
    if (roasterList) {
      roasterList.innerHTML = '';
      Array.from(roasters).sort().forEach(roaster => {
        const option = document.createElement('option');
        option.value = roaster;
        roasterList.appendChild(option);
      });
    }
    
    // Populate process dropdown
    const processSelect = document.getElementById('hist-filter-process') as HTMLSelectElement;
    if (processSelect) {
      const currentValue = processSelect.value;
      processSelect.innerHTML = '<option value="">All processes</option>';
      Array.from(processes).sort().forEach(process => {
        const option = document.createElement('option');
        option.value = process;
        option.textContent = process.charAt(0).toUpperCase() + process.slice(1);
        processSelect.appendChild(option);
      });
      processSelect.value = currentValue;
    }
  }
  
  /**
   * Apply filters to roasts
   */
  private applyFilters(): void {
    const originFilter = (document.getElementById('hist-filter-origin') as HTMLInputElement)?.value.toLowerCase().trim() || '';
    const varietyFilter = (document.getElementById('hist-filter-variety') as HTMLInputElement)?.value.toLowerCase().trim() || '';
    const roasterFilter = (document.getElementById('hist-filter-roaster') as HTMLInputElement)?.value.toLowerCase().trim() || '';
    const processFilter = (document.getElementById('hist-filter-process') as HTMLSelectElement)?.value || '';
    
    this.filteredRoasts = this.allRoasts.filter(roast => {
      if (originFilter && !roast.origin?.toLowerCase().includes(originFilter)) return false;
      if (varietyFilter && !roast.variety?.toLowerCase().includes(varietyFilter)) return false;
      if (roasterFilter && !roast.roaster?.toLowerCase().includes(roasterFilter)) return false;
      if (processFilter && roast.process !== processFilter) return false;
      return true;
    });
    
    this.renderRoastTable();
  }
  
  /**
   * Render the roast selection table
   */
  private renderRoastTable(): void {
    const tbody = document.getElementById('hist-roast-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    if (this.filteredRoasts.length === 0) {
      const row = document.createElement('tr');
      row.innerHTML = '<td colspan="4" style="text-align: center; padding: 20px; color: #999;">No roasts found</td>';
      tbody.appendChild(row);
      return;
    }
    
    this.filteredRoasts.forEach(roast => {
      const row = document.createElement('tr');
      row.style.cursor = 'pointer';
      row.dataset.roastId = roast.id;
      
      // Highlight if selected
      if (this.selectedRoastId === roast.id) {
        row.style.backgroundColor = '#e3f2fd';
      }
      
      // Format date
      const roastDate = roast.roast_date ? this.formatDate(roast.roast_date) : 'N/A';
      
      // Format charge mass
      const chargeMass = roast.charge_mass ? roast.charge_mass.toString() : 'N/A';
      
      row.innerHTML = `
        <td style="padding: 8px;">${roastDate}</td>
        <td style="padding: 8px;">${roast.origin || 'N/A'}</td>
        <td style="padding: 8px;">${roast.variety || 'N/A'}</td>
        <td style="padding: 8px;">${chargeMass}</td>
      `;
      
      // Add click handler
      row.addEventListener('click', () => this.selectRoast(roast.id));
      
      // Add hover effect
      row.addEventListener('mouseenter', () => {
        if (this.selectedRoastId !== roast.id) {
          row.style.backgroundColor = '#f5f5f5';
        }
      });
      row.addEventListener('mouseleave', () => {
        if (this.selectedRoastId !== roast.id) {
          row.style.backgroundColor = '';
        }
      });
      
      tbody.appendChild(row);
    });
  }
  
  /**
   * Select a roast for display
   */
  private async selectRoast(roastId: string): Promise<void> {
    this.selectedRoastId = roastId;
    
    // Update config to include this roast
    // For now, we only support one roast per layer (can extend later)
    this.config.roastIds = [roastId];
    
    // Update table highlighting
    this.renderRoastTable();
    
    // Update selected roast display
    const roast = this.allRoasts.find(r => r.id === roastId);
    if (roast) {
      const selectedRoastDiv = document.getElementById('hist-selected-roast');
      const selectedRoastInfo = document.getElementById('hist-selected-roast-info');
      if (selectedRoastDiv && selectedRoastInfo) {
        selectedRoastDiv.style.display = 'block';
        selectedRoastInfo.innerHTML = `
          <div><strong>${roast.origin || 'Unknown'}</strong> - ${roast.variety || 'Unknown'}</div>
          <div style="font-size: 11px; color: #666;">Date: ${this.formatDate(roast.roast_date)}</div>
          <div style="font-size: 11px; color: #666;">Roaster: ${roast.roaster || 'N/A'}</div>
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
    const colorInput = document.getElementById('hist-color-input') as HTMLInputElement;
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        this.config.color = (e.target as HTMLInputElement).value;
        this.onConfigChange();
      });
    }
    
    // Opacity slider
    const opacityInput = document.getElementById('hist-opacity-input') as HTMLInputElement;
    const opacityValue = document.getElementById('hist-opacity-value');
    if (opacityInput && opacityValue) {
      opacityInput.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.opacity = value / 100;
        opacityValue.textContent = `${value}%`;
        this.onConfigChange();
      });
    }
    
    // Data series toggles
    const btCheckbox = document.getElementById('hist-show-bt') as HTMLInputElement;
    if (btCheckbox) {
      btCheckbox.addEventListener('change', (e) => {
        this.config.showBeanTemp = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const etCheckbox = document.getElementById('hist-show-et') as HTMLInputElement;
    if (etCheckbox) {
      etCheckbox.addEventListener('change', (e) => {
        this.config.showEnvTemp = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const rorCheckbox = document.getElementById('hist-show-ror') as HTMLInputElement;
    if (rorCheckbox) {
      rorCheckbox.addEventListener('change', (e) => {
        this.config.showRoR = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const heaterCheckbox = document.getElementById('hist-show-heater') as HTMLInputElement;
    if (heaterCheckbox) {
      heaterCheckbox.addEventListener('change', (e) => {
        this.config.showHeater = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const fanCheckbox = document.getElementById('hist-show-fan') as HTMLInputElement;
    if (fanCheckbox) {
      fanCheckbox.addEventListener('change', (e) => {
        this.config.showFan = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    const drumCheckbox = document.getElementById('hist-show-drum') as HTMLInputElement;
    if (drumCheckbox) {
      drumCheckbox.addEventListener('change', (e) => {
        this.config.showDrum = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    // Align at charge checkbox
    const alignChargeCheckbox = document.getElementById('hist-align-charge') as HTMLInputElement;
    if (alignChargeCheckbox) {
      alignChargeCheckbox.addEventListener('change', (e) => {
        this.config.alignAtCharge = (e.target as HTMLInputElement).checked;
        this.onConfigChange();
      });
    }
    
    // Filter inputs
    const filterOrigin = document.getElementById('hist-filter-origin');
    const filterVariety = document.getElementById('hist-filter-variety');
    const filterRoaster = document.getElementById('hist-filter-roaster');
    const filterProcess = document.getElementById('hist-filter-process');
    
    if (filterOrigin) filterOrigin.addEventListener('input', () => this.applyFilters());
    if (filterVariety) filterVariety.addEventListener('input', () => this.applyFilters());
    if (filterRoaster) filterRoaster.addEventListener('input', () => this.applyFilters());
    if (filterProcess) filterProcess.addEventListener('change', () => this.applyFilters());
    
    // Clear filters button
    const clearFiltersBtn = document.getElementById('hist-clear-filters');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', () => {
        (document.getElementById('hist-filter-origin') as HTMLInputElement).value = '';
        (document.getElementById('hist-filter-variety') as HTMLInputElement).value = '';
        (document.getElementById('hist-filter-roaster') as HTMLInputElement).value = '';
        (document.getElementById('hist-filter-process') as HTMLSelectElement).value = '';
        this.applyFilters();
      });
    }
  }
  
  /**
   * Get data series for this layer
   * @returns Array of data series to plot
   */
  async getDataSeries(): Promise<DataSeries[]> {
    const series: DataSeries[] = [];
    
    // If no roast selected, return empty
    if (this.config.roastIds.length === 0) {
      return series;
    }
    
    // Get the selected roast
    const roastId = this.config.roastIds[0];
    const roast = this.allRoasts.find(r => r.id === roastId);
    if (!roast) return series;
    
    // Fetch and parse roast data
    try {
      const data = await this.fetchRoastData(roast.file_url, roastId);
      
      // Convert time from minutes to seconds for consistency with canvas
      // Apply time offset if alignAtCharge is enabled
      // When aligned at charge, subtract the charge time so charge occurs at t=0
      const chargeTimeMinutes = data.chargeTime || 0;  // chargeTime from parser (in minutes)
      const chargeTimeSeconds = chargeTimeMinutes * 60;  // Convert to seconds
      
      // Time array: convert each time point from minutes to seconds
      // If alignAtCharge is enabled, offset time so charge event is at t=0
      const timeSeconds = data.timeMinutes.map(t => {
        const seconds = t * 60;  // Convert minutes to seconds
        return this.config.alignAtCharge ? seconds - chargeTimeSeconds : seconds;
      });
      
      // Calculate RoR if needed
      let ror: number[] = [];
      if (this.config.showRoR) {
        ror = calculateRateOfRise(data.beanTemp, data.timeMinutes);
      }
      
      // Base style for this layer
      const baseColor = this.config.color || '#e74c3c';
      
      // Bean temperature trace
      if (this.config.showBeanTemp) {
        series.push({
          label: `BT - ${roast.origin || 'Unknown'}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.beanTemp[i] })),
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
      
      // Environment temperature trace
      if (this.config.showEnvTemp) {
        series.push({
          label: `ET - ${roast.origin || 'Unknown'}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.environmentTemp[i] })),
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
      if (this.config.showRoR) {
        // Filter to only include positive RoR values
        // RoR data structure: map time to RoR, filtering out negative values
        const rorData = timeSeconds
          .map((t, i) => ({ x: t, y: ror[i] }))
          .filter(point => point.y >= 0); // Only positive RoR values
        
        series.push({
          label: `RoR - ${roast.origin || 'Unknown'}`,
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
      
      // Control traces (scaled to 0-100 range, same as temperatures)
      // Note: Control values are already in 0-100 range from the parser
      
      if (this.config.showHeater) {
        series.push({
          label: `Heater - ${roast.origin || 'Unknown'}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.heater[i] })),
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
        series.push({
          label: `Fan - ${roast.origin || 'Unknown'}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.fan[i] })),
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
        series.push({
          label: `Drum - ${roast.origin || 'Unknown'}`,
          data: timeSeconds.map((t, i) => ({ x: t, y: data.drum[i] })),
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
      console.error('Error loading roast data:', error);
    }
    
    return series;
  }
  
  /**
   * Fetch and parse roast file data
   */
  private async fetchRoastData(fileUrl: string, roastId: string): Promise<ParsedRoastData> {
    // Check cache first
    if (this.roastDataCache.has(roastId)) {
      return this.roastDataCache.get(roastId)!;
    }
    
    // Download file from storage
    const { data, error } = await supabase.storage
      .from('roast-data')
      .download(fileUrl);
    
    if (error) {
      throw error;
    }
    
    // Convert blob to text
    const text = await data.text();
    
    // Parse the file
    const parsedData = parseAlogFile(text);
    
    // Cache the result
    this.roastDataCache.set(roastId, parsedData);
    
    return parsedData;
  }
  
  /**
   * Format date string for display
   */
  private formatDate(dateString: string | null): string {
    if (!dateString) return 'N/A';
    
    // Parse date components manually to avoid timezone issues
    const parts = dateString.split('-');
    if (parts.length !== 3) return 'N/A';
    
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    
    const date = new Date(year, month, day);
    
    return date.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric' 
    });
  }
}
