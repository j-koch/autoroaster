/**
 * ALOG Generator
 * 
 * Converts recipe data to Artisan .alog format for export.
 * This allows recipes created in AutoRoaster to be used in Artisan roasting software.
 * 
 * ALOG Format Overview:
 * - Uses Python dict syntax (single quotes, True/False/None)
 * - Contains time series data for temperature and control signals
 * - Includes metadata like roast date, bean info, weight
 * - Has event annotations for CHARGE and DROP times
 * 
 * The format mirrors what the alogParser expects to read.
 */

/**
 * Recipe data structure (from RecipeVisualizer.ts)
 * This is what we receive from the database and need to convert to .alog
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
  // Simulated results: predicted temperature profiles
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
 * Generate an Artisan .alog file from recipe data
 * 
 * The .alog format uses Python dict syntax, so we manually construct the string
 * rather than using JSON.stringify.
 * 
 * Key mappings:
 * - timex: time in seconds from recipe.simulated_results.time
 * - temp2 (BT): bean probe temperature from recipe.simulated_results.bean_temp
 * - temp1 (ET): environment probe temp from recipe.simulated_results.env_probe_temp
 * - extratemp1[0]: heater control (0-100 scale)
 * - extratemp2[0]: fan control (0-100 scale)
 * - extratemp1[2]: drum speed (0-100 scale)
 * - extratemp2[1]: ambient temperature (constant)
 * - extratemp2[2]: humidity (default 50%)
 * - weight: bean mass in grams
 * - anno_positions: CHARGE at t=0, DROP at end time
 * 
 * @param recipe - Recipe data to convert
 * @returns String content of .alog file in Python dict format
 */
export function generateAlogFile(recipe: Recipe): string {
  // Get time series data
  const time = recipe.simulated_results.time;  // Time in seconds
  const beanTemp = recipe.simulated_results.bean_temp;  // BT (°C)
  const envTemp = recipe.simulated_results.env_probe_temp;  // ET (°C)
  
  // Interpolate control signals to match simulation time points
  // Each control has its own time array (discrete events)
  const heaterInterp = interpolateControlToTime(
    recipe.control_profile.heater.time,
    recipe.control_profile.heater.values,
    time
  );
  const fanInterp = interpolateControlToTime(
    recipe.control_profile.fan.time,
    recipe.control_profile.fan.values,
    time
  );
  const drumInterp = interpolateControlToTime(
    recipe.control_profile.drum.time,
    recipe.control_profile.drum.values,
    time
  );
  
  // Convert control signals from 0-1 scale to 0-100 scale for .alog format
  const heater100 = heaterInterp.map(h => h * 100);
  const fan100 = fanInterp.map(f => f * 100);
  const drum100 = drumInterp.map(d => d * 100);
  
  // Create ambient temperature and humidity arrays (constant values)
  const ambientTemp = new Array(time.length).fill(recipe.ambient_temp_c);
  const humidity = new Array(time.length).fill(50);  // Default 50% humidity
  
  // Format date string (YYYY-MM-DD format)
  const createdDate = new Date(recipe.created_at);
  const dateStr = createdDate.toISOString().split('T')[0];
  
  // Build the .alog file content using Python dict syntax
  // Note: Use single quotes for strings and True/False/None (not true/false/null)
  let alogContent = '{\n';
  
  // Metadata fields
  alogContent += `'roastdate': '${dateStr}',\n`;
  alogContent += `'title': '${escapeSingleQuotes(recipe.name)}',\n`;
  alogContent += `'beans': 'AutoRoaster Recipe',\n`;
  
  // Weight: [value, decimals, unit]
  // Format: [mass_value, 0, 'g'] where decimals=0 means integer grams
  alogContent += `'weight': [${recipe.bean_mass_g}, 0, 'g'],\n`;
  
  // Ambient conditions (recorded at time of recipe creation)
  alogContent += `'ambient_temp': ${recipe.ambient_temp_c},\n`;
  
  // Time series data - timex is the time array in seconds
  alogContent += `'timex': ${formatPythonArray(time)},\n`;
  
  // Temperature data
  // temp2 = BT (Bean Temperature), temp1 = ET (Environment Temperature)
  alogContent += `'temp2': ${formatPythonArray(beanTemp)},\n`;
  alogContent += `'temp1': ${formatPythonArray(envTemp)},\n`;
  
  // Control signals in extratemp arrays
  // extratemp1: [heater, None, drum_speed]
  // extratemp2: [fan, ambient_temp, humidity]
  alogContent += `'extratemp1': [\n`;
  alogContent += `  ${formatPythonArray(heater100)},\n`;
  alogContent += `  None,\n`;
  alogContent += `  ${formatPythonArray(drum100)}\n`;
  alogContent += `],\n`;
  
  alogContent += `'extratemp2': [\n`;
  alogContent += `  ${formatPythonArray(fan100)},\n`;
  alogContent += `  ${formatPythonArray(ambientTemp)},\n`;
  alogContent += `  ${formatPythonArray(humidity)}\n`;
  alogContent += `],\n`;
  
  // Special events: encode control changes as discrete events
  // These are critical for Artisan to display controls properly
  // Format: events occur at time indices (not seconds) into the timex array
  // specialevents: array of indices into timex where events occur
  // specialeventstype: array of event types (0=fan, 1=drum, 3=heater)
  // specialeventsvalue: array of event values (power levels 0-10 scale)
  // specialeventsStrings: array of string labels for events
  // Use the original control profile times (not interpolated) to create proper step functions
  const specialEvents = generateSpecialEvents(
    time,
    recipe.control_profile.heater.time,
    recipe.control_profile.heater.values,
    recipe.control_profile.fan.time,
    recipe.control_profile.fan.values,
    recipe.control_profile.drum.time,
    recipe.control_profile.drum.values
  );
  
  alogContent += `'specialevents': ${formatPythonIntArray(specialEvents.events)},\n`;
  alogContent += `'specialeventstype': ${formatPythonIntArray(specialEvents.types)},\n`;
  alogContent += `'specialeventsvalue': ${formatPythonArray(specialEvents.values)},\n`;
  alogContent += `'specialeventsStrings': ${formatPythonStringArray(specialEvents.strings)},\n`;
  
  // Event annotations: CHARGE at t=0, DROP at end
  // Format: [[event_id, time_seconds, temperature], ...]
  // CHARGE: event_id = 0
  // DROP: event_id = 6
  const chargeTime = 0;
  const dropTime = time[time.length - 1];
  const dropTemp = beanTemp[beanTemp.length - 1];
  
  alogContent += `'anno_positions': [\n`;
  alogContent += `  [0, ${chargeTime}, 0],\n`;  // CHARGE at start
  alogContent += `  [6, ${dropTime}, ${dropTemp.toFixed(1)}]\n`;  // DROP at end
  alogContent += `],\n`;
  
  // Labels for events
  alogContent += `'anno_labels': ['CHARGE', 'DROP'],\n`;
  
  // Optional: include target temperature if available
  if (recipe.target_temp_c !== null) {
    alogContent += `'target_temp': ${recipe.target_temp_c},\n`;
  }
  
  // Mark as AutoRoaster generated
  alogContent += `'source': 'AutoRoaster Recipe Export',\n`;
  alogContent += `'recipe_id': '${recipe.id}'\n`;
  
  alogContent += '}';
  
  return alogContent;
}

/**
 * Generate special events for control changes
 * 
 * Artisan uses special events to encode control changes as discrete events.
 * These create piecewise constant control functions in Artisan.
 * 
 * Event types:
 * - Type 0: Fan speed change
 * - Type 1: Drum speed change
 * - Type 3: Heater power change
 * 
 * Values are on a 0-10 scale (divide 0-100 scale by 10)
 * 
 * @param simTime - Simulation time array (seconds) from results
 * @param heaterTime - Time points for heater control changes (seconds)
 * @param heaterValues - Heater power values (0-1 scale) at each time point
 * @param fanTime - Time points for fan control changes (seconds)
 * @param fanValues - Fan speed values (0-1 scale) at each time point
 * @param drumTime - Time points for drum control changes (seconds)
 * @param drumValues - Drum speed values (0-1 scale) at each time point
 * @returns Object with parallel arrays for events, types, values, and strings
 */
function generateSpecialEvents(
  simTime: number[],
  heaterTime: number[],
  heaterValues: number[],
  fanTime: number[],
  fanValues: number[],
  drumTime: number[],
  drumValues: number[]
): {
  events: number[];
  types: number[];
  values: number[];
  strings: string[];
} {
  const events: number[] = [];
  const types: number[] = [];
  const values: number[] = [];
  const strings: string[] = [];
  
  // Helper function to find the closest time index in simTime array
  // This maps control change times to simulation time indices
  function findTimeIndex(targetTime: number): number {
    // Find the index in simTime that is closest to targetTime
    let closestIndex = 0;
    let minDiff = Math.abs(simTime[0] - targetTime);
    
    for (let i = 1; i < simTime.length; i++) {
      const diff = Math.abs(simTime[i] - targetTime);
      if (diff < minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
      // Stop searching if we've passed the target time
      if (simTime[i] > targetTime) {
        break;
      }
    }
    
    return closestIndex;
  }
  
  // Process heater changes
  let prevHeater = -1;
  for (let i = 0; i < heaterTime.length; i++) {
    const heaterValue = Math.round(heaterValues[i] * 100);  // Convert 0-1 to 0-100
    const timeIndex = findTimeIndex(heaterTime[i]);
    
    // Detect heater change
    if (heaterValue !== prevHeater) {
      events.push(timeIndex);
      types.push(3);  // Type 3 = heater
      values.push(heaterValue / 10);  // Convert 0-100 to 0-10 scale
      strings.push(`Q${heaterValue}`);  // Format: Q35 for 35% power
      prevHeater = heaterValue;
    }
  }
  
  // Process fan changes
  let prevFan = -1;
  for (let i = 0; i < fanTime.length; i++) {
    const fanValue = Math.round(fanValues[i] * 100);  // Convert 0-1 to 0-100
    const timeIndex = findTimeIndex(fanTime[i]);
    
    // Detect fan change
    if (fanValue !== prevFan) {
      events.push(timeIndex);
      types.push(0);  // Type 0 = fan
      values.push(fanValue / 10);  // Convert 0-100 to 0-10 scale
      strings.push(`${fanValue}%`);  // Format: 50% for 50% speed
      prevFan = fanValue;
    }
  }
  
  // Process drum changes
  let prevDrum = -1;
  for (let i = 0; i < drumTime.length; i++) {
    const drumValue = Math.round(drumValues[i] * 100);  // Convert 0-1 to 0-100
    const timeIndex = findTimeIndex(drumTime[i]);
    
    // Detect drum change
    if (drumValue !== prevDrum) {
      events.push(timeIndex);
      types.push(1);  // Type 1 = drum
      values.push(drumValue / 10);  // Convert 0-100 to 0-10 scale
      strings.push(`D${drumValue}`);  // Format: D60 for 60% drum speed
      prevDrum = drumValue;
    }
  }
  
  return { events, types, values, strings };
}

/**
 * Format a string array as a Python list string
 * 
 * Converts JavaScript string array to Python list syntax with proper quoting.
 * Empty strings are represented as '' (empty single-quoted string).
 * 
 * @param arr - Array of strings
 * @returns Formatted Python list string (e.g., "['a', 'b', 'c']")
 */
function formatPythonStringArray(arr: string[]): string {
  const formatted = arr.map(s => {
    if (s === '' || s === null || s === undefined) {
      return "''";  // Empty Python string
    }
    // Escape single quotes and wrap in quotes
    return `'${escapeSingleQuotes(s)}'`;
  });
  
  return `[${formatted.join(', ')}]`;
}

/**
 * Interpolate control signal values to match simulation time points
 * 
 * Control profiles may have fewer time points than simulation results,
 * so we need to interpolate to match the simulation timeline.
 * 
 * Uses step function (zero-order hold) interpolation - control values
 * remain constant until the next control point. This matches the actual
 * behavior of control signals which are piecewise constant, not continuous.
 * 
 * @param controlTime - Time points for control signal (seconds)
 * @param controlValues - Control signal values (0-1 scale)
 * @param targetTime - Target time points to interpolate to (seconds)
 * @returns Interpolated control values at target time points (step function)
 */
function interpolateControlToTime(
  controlTime: number[],
  controlValues: number[],
  targetTime: number[]
): number[] {
  const interpolated: number[] = [];
  
  for (const t of targetTime) {
    let value = 0;
    
    if (t < controlTime[0]) {
      // Before first control point - use first value
      value = controlValues[0];
    } else if (t >= controlTime[controlTime.length - 1]) {
      // After last control point - use last value
      value = controlValues[controlValues.length - 1];
    } else {
      // Find the control point at or before current time t
      // Use step function (zero-order hold): hold value until next control point
      for (let i = controlTime.length - 1; i >= 0; i--) {
        if (t >= controlTime[i]) {
          value = controlValues[i];
          break;
        }
      }
    }
    
    interpolated.push(value);
  }
  
  return interpolated;
}

/**
 * Format an integer array as a Python list string
 * 
 * Converts JavaScript array to Python list syntax with integer formatting.
 * This is used for arrays that must contain integers (like specialevents indices).
 * 
 * @param arr - Array of numbers (will be rounded to integers)
 * @returns Formatted Python list string (e.g., "[1, 2, 3]")
 */
function formatPythonIntArray(arr: number[]): string {
  // Round to integers and format as string
  const formatted = arr.map(n => {
    if (isNaN(n) || !isFinite(n)) {
      return 'None';  // Python's null equivalent
    }
    return Math.round(n).toString();
  });
  
  return `[${formatted.join(', ')}]`;
}

/**
 * Format a number array as a Python list string
 * 
 * Converts JavaScript array to Python list syntax with proper number formatting.
 * Numbers are rounded to 2 decimal places to reduce file size.
 * 
 * @param arr - Array of numbers
 * @returns Formatted Python list string (e.g., "[1.0, 2.5, 3.2]")
 */
function formatPythonArray(arr: number[]): string {
  // Round numbers to 2 decimal places and format as string
  const formatted = arr.map(n => {
    if (isNaN(n) || !isFinite(n)) {
      return 'None';  // Python's null equivalent
    }
    return n.toFixed(2);
  });
  
  return `[${formatted.join(', ')}]`;
}

/**
 * Escape single quotes in strings for Python dict syntax
 * 
 * @param str - String to escape
 * @returns Escaped string safe for Python single-quoted strings
 */
function escapeSingleQuotes(str: string): string {
  return str.replace(/'/g, "\\'");
}

/**
 * Trigger download of .alog file
 * 
 * Creates a Blob from the .alog content and triggers a browser download.
 * 
 * @param alogContent - The .alog file content string
 * @param filename - Desired filename (without extension)
 */
export function downloadAlogFile(alogContent: string, filename: string): void {
  // Create a Blob with the .alog content
  // Use text/plain MIME type for text files
  const blob = new Blob([alogContent], { type: 'text/plain' });
  
  // Create a temporary download link
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  
  // Set filename with .alog extension
  // Clean filename to remove invalid characters
  const cleanFilename = filename.replace(/[^a-zA-Z0-9_\-]/g, '_');
  link.download = `${cleanFilename}.alog`;
  
  // Trigger download
  document.body.appendChild(link);
  link.click();
  
  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
