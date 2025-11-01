/**
 * Chart Manager
 * 
 * Manages Plotly charts for the roaster simulator.
 * Provides utilities for:
 * - Initializing charts with proper layout
 * - Updating chart data efficiently
 * - Managing forecast visualization
 * - Handling dual-axis plots (temperature + rate of rise)
 */

import * as Plotly from 'plotly.js-dist-min';
import type {
  PlotlyTrace,
  PlotlyLayout,
  TemperatureData,
  ControlData,
  ForecastData
} from './types';

export class ChartManager {
  // Chart container IDs
  private temperatureChartId: string;
  private controlChartId: string;
  
  // Configuration
  private responsive: boolean;
  
  /**
   * Create a ChartManager instance
   * 
   * @param temperatureChartId - DOM element ID for temperature chart
   * @param controlChartId - DOM element ID for control chart
   * @param responsive - Enable responsive sizing (default: true)
   */
  constructor(
    temperatureChartId: string = 'temperature-chart',
    controlChartId: string = 'control-chart',
    responsive: boolean = true
  ) {
    this.temperatureChartId = temperatureChartId;
    this.controlChartId = controlChartId;
    this.responsive = responsive;
  }
  
  /**
   * Initialize temperature chart with dual y-axis
   * 
   * Left axis: Temperature (°C)
   * Right axis: Rate of Rise (°C/min)
   * 
   * Includes traces for:
   * - Bean probe temperature
   * - Bean surface temperature
   * - Drum temperature
   * - Environment probe temperature
   * - Rate of Rise
   * - 5 forecast traces (bean, surface, drum, air, RoR)
   * - Background reference profile
   */
  initializeTemperatureChart(): void {
    const traces: PlotlyTrace[] = [
      // Main temperature traces
      {
        x: [],
        y: [],
        name: 'Bean Probe',
        line: { color: '#8B4513', width: 3 },
        yaxis: 'y',
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Bean Surface',
        line: { color: '#FF6B35', width: 2 },
        yaxis: 'y',
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Drum',
        line: { color: '#4ECDC4', width: 2 },
        yaxis: 'y',
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Env. Probe',
        line: { color: '#45B7D1', width: 2 },
        yaxis: 'y',
        mode: 'lines'
      },
      // Rate of Rise on secondary axis
      {
        x: [],
        y: [],
        name: 'Rate of Rise',
        line: { color: '#FF1493', width: 2, dash: 'dot' },
        yaxis: 'y2',
        mode: 'lines'
      },
      // Forecast traces (hidden from legend)
      {
        x: [],
        y: [],
        name: 'Bean Forecast',
        line: { color: '#8B4513', width: 2, dash: 'dash' },
        yaxis: 'y',
        opacity: 0.6,
        showlegend: false,
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Surface Forecast',
        line: { color: '#FF6B35', width: 1.5, dash: 'dash' },
        yaxis: 'y',
        opacity: 0.5,
        showlegend: false,
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Drum Forecast',
        line: { color: '#4ECDC4', width: 1.5, dash: 'dash' },
        yaxis: 'y',
        opacity: 0.5,
        showlegend: false,
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Air Forecast',
        line: { color: '#45B7D1', width: 1.5, dash: 'dash' },
        yaxis: 'y',
        opacity: 0.5,
        showlegend: false,
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'RoR Forecast',
        line: { color: '#FF1493', width: 2, dash: 'dash' },
        yaxis: 'y2',
        opacity: 0.6,
        showlegend: false,
        mode: 'lines'
      }
    ];
    
    const layout: PlotlyLayout = {
      title: 'Temperature Profile & Rate of Rise',
      xaxis: {
        title: 'Time (minutes)',
        gridcolor: '#e0e0e0'
      },
      yaxis: {
        title: 'Temperature (°C)',
        side: 'left',
        gridcolor: '#e0e0e0'
      },
      yaxis2: {
        title: 'Rate of Rise (°C/min)',
        side: 'right',
        overlaying: 'y',
        showgrid: false,
        zeroline: true,
        zerolinecolor: '#666',
        zerolinewidth: 1,
        range: [0, null] as any  // Start at 0, auto-scale max
      },
      showlegend: true,
      margin: { t: 50, r: 80, b: 50, l: 50 },
      hovermode: 'closest'
    };
    
    const config = {
      responsive: this.responsive,
      displayModeBar: false
    };
    
    Plotly.newPlot(this.temperatureChartId, traces, layout as any, config);
  }
  
  /**
   * Initialize control chart
   * 
   * Shows heater power, fan speed, and drum speed over time.
   */
  initializeControlChart(): void {
    const traces: PlotlyTrace[] = [
      {
        x: [],
        y: [],
        name: 'Heat',
        line: { color: '#FF4444', width: 2 },
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Fan',
        line: { color: '#4444FF', width: 2 },
        mode: 'lines'
      },
      {
        x: [],
        y: [],
        name: 'Drum (fixed)',
        line: { color: '#888888', width: 2, dash: 'dash' },
        mode: 'lines'
      }
    ];
    
    const layout: PlotlyLayout = {
      title: 'Control Inputs',
      xaxis: {
        title: 'Time (minutes)',
        gridcolor: '#e0e0e0'
      },
      yaxis: {
        title: 'Control Value (0-1)',
        range: [0, 1],
        gridcolor: '#e0e0e0'
      },
      showlegend: true,
      margin: { t: 50, r: 50, b: 50, l: 50 },
      hovermode: 'closest'
    };
    
    const config = {
      responsive: this.responsive,
      displayModeBar: false
    };
    
    Plotly.newPlot(this.controlChartId, traces, layout as any, config);
  }
  
  /**
   * Update temperature chart with new data
   * 
   * @param timeData - Time points in minutes
   * @param tempData - Temperature data collection
   * @param rateOfRiseData - Rate of rise data (°C/min)
   * @param forecastData - Forecast data (optional)
   * @param backgroundProfile - Reference profile (optional)
   * @param currentTime - Current time for vertical line marker
   */
  updateTemperatureChart(
    timeData: number[],
    tempData: TemperatureData,
    rateOfRiseData: number[],
    forecastData?: ForecastData,
    backgroundProfile?: { times: number[], temps: number[] },
    currentTime?: number
  ): void {
    // Prepare data arrays for all traces
    const xData = [
      timeData,  // Bean
      timeData,  // Surface
      timeData,  // Drum
      timeData,  // Env Probe
      timeData,  // RoR
      forecastData?.time || [],  // Bean forecast
      forecastData?.time || [],  // Surface forecast
      forecastData?.time || [],  // Drum forecast
      forecastData?.time || [],  // Air forecast
      forecastData?.time || [],  // RoR forecast
      backgroundProfile?.times || []  // Reference profile
    ];
    
    const yData = [
      tempData.bean,
      tempData.environment,
      tempData.roaster,
      tempData.airMeasured,
      rateOfRiseData,
      forecastData?.bean || [],
      forecastData?.environment || [],
      forecastData?.roaster || [],
      forecastData?.air || [],
      forecastData?.rateOfRise || [],
      backgroundProfile?.temps || []
    ];
    
    // Update traces
    Plotly.restyle(this.temperatureChartId, { x: xData, y: yData });
    
    // Calculate axis ranges
    const maxTime = Math.max(
      10,
      timeData.length > 0 ? timeData[timeData.length - 1] + 1 : 10,
      forecastData && forecastData.time.length > 0 ? 
        forecastData.time[forecastData.time.length - 1] + 0.5 : 10
    );
    
    const allTemps = [
      ...tempData.bean,
      ...tempData.environment,
      ...tempData.roaster,
      ...tempData.air
    ];
    const maxTemp = Math.max(200, ...allTemps.map(t => t + 25));
    
    const maxRoR = Math.max(10, ...rateOfRiseData.map(r => r + 2));
    
    // Add vertical line at current time if provided
    const shapes = currentTime && timeData.length > 0 ? [{
      type: 'line' as const,
      x0: currentTime,
      x1: currentTime,
      y0: 0,
      y1: 1,
      yref: 'paper' as const,
      line: {
        color: 'rgba(0, 0, 0, 0.3)',
        width: 2,
        dash: 'dot'
      }
    }] : [];
    
    // Update layout (using any to bypass Plotly type restrictions)
    Plotly.relayout(this.temperatureChartId, {
      'xaxis.range': [0, maxTime],
      'yaxis.range': [0, maxTemp],
      'yaxis2.range': [0, maxRoR],
      shapes: shapes as any
    } as any);
  }
  
  /**
   * Update control chart with new data
   * 
   * @param timeData - Time points in minutes
   * @param controlData - Control data collection
   * @param currentTime - Current time for vertical line marker
   */
  updateControlChart(
    timeData: number[],
    controlData: ControlData,
    currentTime?: number
  ): void {
    // Update traces
    Plotly.restyle(this.controlChartId, {
      x: [timeData, timeData, timeData],
      y: [controlData.heater, controlData.fan, controlData.drum]
    });
    
    // Calculate x-axis range
    const maxTime = Math.max(
      10,
      timeData.length > 0 ? timeData[timeData.length - 1] + 1 : 10
    );
    
    // Add vertical line at current time if provided
    const shapes = currentTime && timeData.length > 0 ? [{
      type: 'line' as const,
      x0: currentTime,
      x1: currentTime,
      y0: 0,
      y1: 1,
      yref: 'paper' as const,
      line: {
        color: 'rgba(0, 0, 0, 0.3)',
        width: 2,
        dash: 'dot'
      }
    }] : [];
    
    // Update layout
    Plotly.relayout(this.controlChartId, {
      'xaxis.range': [0, maxTime],
      shapes: shapes as any
    } as any);
  }
  
  /**
   * Add background profile trace to temperature chart
   * 
   * Should be called after initializeTemperatureChart.
   * Adds the reference profile as the 11th trace (index 10).
   * 
   * @param times - Time points for profile
   * @param temps - Temperature points for profile
   */
  addBackgroundProfile(times: number[], temps: number[]): void {
    const trace: PlotlyTrace = {
      x: times,
      y: temps,
      name: 'Target Profile',
      line: {
        color: 'rgba(139, 69, 19, 0.4)',
        width: 3,
        dash: 'dashdot'
      },
      yaxis: 'y',
      mode: 'lines',
      hovertemplate: 'Target: %{y:.1f}°C<br>Time: %{x:.2f} min<extra></extra>'
    };
    
    Plotly.addTraces(this.temperatureChartId, trace);
  }
  
  /**
   * Update existing background profile
   * 
   * @param times - New time points
   * @param temps - New temperature points
   */
  updateBackgroundProfile(times: number[], temps: number[]): void {
    Plotly.restyle(this.temperatureChartId, {
      x: [times],
      y: [temps]
    }, [10]);  // Update trace at index 10
  }
}
