/**
 * Canvas Types
 * 
 * Type definitions for the Canvas layer system.
 * Defines interfaces for layers, chart data, and layer-specific configurations.
 */

/**
 * Layer type enumeration
 * Each type corresponds to a different data source
 */
export type LayerType = 'historical' | 'recipe' | 'simulator' | 'generator';

/**
 * Base layer configuration
 * All layer types extend this interface
 */
export interface LayerConfig {
  id: string;                  // Unique identifier for the layer
  type: LayerType;             // Type of layer
  name: string;                // Display name
  visible: boolean;            // Whether layer is currently visible
  opacity: number;             // Layer opacity (0-1)
}

/**
 * Visual style configuration for a layer
 * Controls how the layer's data is rendered on the chart
 */
export interface LayerStyle {
  color: string;               // Primary color for this layer (hex color code)
  lineWidth: number;           // Line thickness in pixels
  showPoints: boolean;         // Whether to show data points
  pointRadius: number;         // Size of data points
  lineDash: number[];          // Dash pattern for lines (empty = solid)
  fill: boolean;               // Whether to fill area under line
  fillOpacity: number;         // Opacity of fill (0-1)
}

/**
 * Data series for a single trace/line on the chart
 * Each layer can produce multiple data series (e.g., BT, ET, RoR)
 */
export interface DataSeries {
  label: string;               // Display label for this series
  data: { x: number; y: number }[];  // Time-value pairs (x=time in seconds, y=value)
  style: LayerStyle;           // Visual styling for this series
  yAxisID?: string;            // Which y-axis to use ('y' or 'y2')
}

/**
 * Historical roast layer configuration
 * Displays data from past roasts
 */
export interface HistoricalLayerConfig extends LayerConfig {
  type: 'historical';
  roastIds: string[];          // IDs of roasts to display
  showBeanTemp: boolean;       // Show bean temperature trace
  showEnvTemp: boolean;        // Show environment temperature trace
  showRoR: boolean;            // Show rate of rise trace
  showHeater: boolean;         // Show heater control trace
  showFan: boolean;            // Show fan control trace
  showDrum: boolean;           // Show drum control trace
  alignAtCharge: boolean;      // Whether to align roasts at charge point (t=0)
  color?: string;              // Optional color override for this layer
}

/**
 * Recipe layer configuration
 * Displays saved recipe profiles
 */
export interface RecipeLayerConfig extends LayerConfig {
  type: 'recipe';
  recipeId: string;            // ID of recipe to display
  showBeanTemp: boolean;       // Show bean temperature trace
  showEnvTemp: boolean;        // Show environment temperature trace
  showRoR: boolean;            // Show rate of rise trace
  showHeater: boolean;         // Show heater control trace
  showFan: boolean;            // Show fan control trace
  showDrum: boolean;           // Show drum control trace
  color?: string;              // Optional color override for this layer
}

/**
 * Simulator layer configuration
 * Interactive simulation layer with adjustable parameters
 */
export interface SimulatorLayerConfig extends LayerConfig {
  type: 'simulator';
  roasterModelId: string;      // ID of roaster model to use
  beanModelId: string;         // ID of bean model to use
  beanMassG: number;           // Bean mass in grams
  ambientTempC: number;        // Ambient temperature in Celsius
  preheatTempC: number;        // Preheat/initial temperature
  durationSeconds: number;     // Simulation duration
  heaterProfile: { time: number; value: number }[];  // Heater control points
  fanProfile: { time: number; value: number }[];     // Fan control points
  drumProfile: { time: number; value: number }[];    // Drum control points
  color?: string;              // Optional color override for this layer
}

/**
 * Generator layer configuration
 * Recipe generation with interactive control editing
 */
export interface GeneratorLayerConfig extends LayerConfig {
  type: 'generator';
  roasterModelId: string;      // ID of roaster model to use
  beanModelId: string;         // ID of bean model to use
  beanMassG: number;           // Bean mass in grams
  ambientTempC: number;        // Ambient temperature
  preheatTempC: number;        // Preheat temperature
  durationSeconds: number;     // Duration in seconds
  heaterProfile: { time: number; value: number }[];  // Heater control points
  fanProfile: { time: number; value: number }[];     // Fan control points
  drumProfile: { time: number; value: number }[];    // Drum control points
  color?: string;              // Optional color override for this layer
}

/**
 * Union type for all layer configurations
 * Used for type-safe layer storage and serialization
 */
export type AnyLayerConfig = 
  | HistoricalLayerConfig 
  | RecipeLayerConfig 
  | SimulatorLayerConfig 
  | GeneratorLayerConfig;

/**
 * Parsed roast data structure (from alogParser)
 * Matches the structure returned by the alog parser
 */
export interface ParsedRoastData {
  timeMinutes: number[];
  beanTemp: number[];
  environmentTemp: number[];
  roasterTemp: number[];
  airMeasured: number[];
  heater: number[];
  fan: number[];
  drum: number[];
  chargeTime?: number;
}

/**
 * Recipe data structure (from database)
 */
export interface Recipe {
  id: string;
  user_id: string;
  name: string;
  duration_seconds: number;
  bean_mass_g: number;
  ambient_temp_c: number;
  roaster_model_id: string;
  bean_model_id: string;
  control_profile: {
    heater: { time: number[]; values: number[] };
    fan: { time: number[]; values: number[] };
    drum: { time: number[]; values: number[] };
  };
  simulated_results: {
    time: number[];
    bean_temp: number[];
    bean_surface_temp: number[];
    drum_temp: number[];
    air_temp: number[];
    env_probe_temp: number[];
  };
  target_temp_c: number;
  created_at: string;
}

/**
 * Roast metadata structure (from database)
 */
export interface Roast {
  id: string;
  user_id: string;
  filename: string;
  file_url: string;
  upload_date: string;
  roaster: string | null;
  origin: string | null;
  variety: string | null;
  roast_date: string | null;
  process: string | null;
  charge_mass: number | null;
  final_mass: number | null;
  ambient_temp: number | null;
  relative_humidity: number | null;
}

/**
 * Canvas state for persistence
 * Can be saved/loaded to restore canvas configuration
 */
export interface CanvasState {
  layers: AnyLayerConfig[];
  chartOptions: {
    xAxisMin: number;
    xAxisMax: number;
    yAxisMin: number;
    yAxisMax: number;
  };
}
