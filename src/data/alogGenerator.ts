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
  // Get time series data from simulation results
  const simTime = recipe.simulated_results.time;  // Time in seconds (starts at 0)
  const simBeanTemp = recipe.simulated_results.bean_temp;  // BT (°C)
  const simEnvTemp = recipe.simulated_results.env_probe_temp;  // ET (°C)
  
  // ========================================================================
  // PRE-CHARGE PERIOD: Add ~10 seconds of pre-roast data before CHARGE
  // ========================================================================
  // Artisan expects pre-charge data to understand the roaster's initial temperature
  // state. Without this, Artisan cannot properly sync background curves with live
  // roasts because the CHARGE event has no temporal context.
  //
  // We'll prepend pre-charge time points with constant preheat temperatures.
  // The CHARGE event will occur at the first simulation point (which will have a 
  // positive time value after we add the pre-charge offset).
  //
  // Real Artisan files typically have:
  // - Pre-charge data starting at small positive time (e.g., 0.72 seconds)
  // - CHARGE event at a later positive time (e.g., 9.72 seconds)
  // - Roasting data continuing from there
  
  const PRECHARGE_DURATION_SEC = 10.0;  // Duration of pre-charge period (seconds)
  const PRECHARGE_SAMPLE_INTERVAL = 1.5;  // Time between pre-charge samples (seconds)
  const PRECHARGE_START_TIME = 0.72;  // Starting time for pre-charge data (seconds)
  
  // Generate pre-charge time array (positive times before CHARGE)
  // Example: [0.72, 2.22, 3.72, 5.22, 6.72, 8.22]
  const prechargeTimePoints: number[] = [];
  for (let t = PRECHARGE_START_TIME; t < PRECHARGE_START_TIME + PRECHARGE_DURATION_SEC; t += PRECHARGE_SAMPLE_INTERVAL) {
    prechargeTimePoints.push(t);
  }
  
  // Calculate the CHARGE time (where simulation starts)
  // This will be the time value at chargeIndex
  const chargeTime = PRECHARGE_START_TIME + PRECHARGE_DURATION_SEC;
  
  // Pre-charge temperatures: use initial simulation temperatures
  // These represent the roaster's preheat state before beans are added
  const preheatBeanTemp = simBeanTemp[0];  // Initial bean probe temp (roaster preheat temp)
  const preheatEnvTemp = simEnvTemp[0];    // Initial environment temp
  
  // Create pre-charge temperature arrays (constant values during preheat)
  const prechargeBeanTemp = new Array(prechargeTimePoints.length).fill(preheatBeanTemp);
  const prechargeEnvTemp = new Array(prechargeTimePoints.length).fill(preheatEnvTemp);
  
  // Offset simulation time to continue from CHARGE time
  // Add chargeTime to all simulation time points
  const offsetSimTime = simTime.map(t => t + chargeTime);
  
  // Concatenate pre-charge data with offset simulation data
  // After concatenation:
  // - time array starts with small positive values (pre-charge period)
  // - CHARGE event occurs at chargeTime (e.g., ~10.72 seconds)
  // - Simulation results continue from there with increasing positive times
  const time = [...prechargeTimePoints, ...offsetSimTime];
  const beanTemp = [...prechargeBeanTemp, ...simBeanTemp];
  const envTemp = [...prechargeEnvTemp, ...simEnvTemp];
  
  // Store the index where CHARGE occurs (first simulation point)
  // This is needed for annotating the CHARGE event correctly
  const chargeIndex = prechargeTimePoints.length;
  
  // ========================================================================
  // CONTROL SIGNALS: Interpolate and prepend pre-charge values
  // ========================================================================
  
  // Interpolate control signals to match simulation time points only
  // (we'll prepend pre-charge values separately)
  const simHeaterInterp = interpolateControlToTime(
    recipe.control_profile.heater.time,
    recipe.control_profile.heater.values,
    simTime
  );
  const simFanInterp = interpolateControlToTime(
    recipe.control_profile.fan.time,
    recipe.control_profile.fan.values,
    simTime
  );
  const simDrumInterp = interpolateControlToTime(
    recipe.control_profile.drum.time,
    recipe.control_profile.drum.values,
    simTime
  );
  
  // During pre-charge period, use initial control values
  // (roaster is preheating with these settings before beans are added)
  const prechargeHeater = new Array(prechargeTimePoints.length).fill(simHeaterInterp[0]);
  const prechargeFan = new Array(prechargeTimePoints.length).fill(simFanInterp[0]);
  const prechargeDrum = new Array(prechargeTimePoints.length).fill(simDrumInterp[0]);
  
  // Concatenate pre-charge control values with simulation control values
  const heaterInterp = [...prechargeHeater, ...simHeaterInterp];
  const fanInterp = [...prechargeFan, ...simFanInterp];
  const drumInterp = [...prechargeDrum, ...simDrumInterp];
  
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
  
  // Time index array - indices into timex array for standard roasting events
  // IMPORTANT: This must appear early in the file for Artisan to recognize events properly
  // This is an 8-element array that Artisan uses to quickly locate standard events:
  // [CHARGE_idx, TP_idx, DRY_idx, FCs_idx, FCe_idx, SCs_idx, DROP_idx, Cool_idx]
  // For AutoRoaster exports, we only have CHARGE and DROP events, so set others to 0
  const timeindexArray = [
    chargeIndex,           // Position 0: CHARGE event index
    0,                     // Position 1: TP (Turning Point) - not available
    0,                     // Position 2: DRY end - not available  
    0,                     // Position 3: FCs (First Crack start) - not available
    0,                     // Position 4: FCe (First Crack end) - not available
    0,                     // Position 5: SCs (Second Crack start) - not available
    time.length - 1,       // Position 6: DROP event index
    0                      // Position 7: Cooling phase - not available
  ];
  alogContent += `'timeindex': ${formatPythonIntArray(timeindexArray)},\n`;
  
  // Ambient conditions (recorded at time of recipe creation)
  alogContent += `'ambient_temp': ${recipe.ambient_temp_c},\n`;
  
  // Time series data - timex is the time array in seconds
  alogContent += `'timex': ${formatPythonArray(time)},\n`;
  
  // Temperature data
  // temp2 = BT (Bean Temperature), temp1 = ET (Environment Temperature)
  alogContent += `'temp2': ${formatPythonArray(beanTemp)},\n`;
  alogContent += `'temp1': ${formatPythonArray(envTemp)},\n`;
  
  // Control signals - Artisan uses two arrays for extra channels
  // extratemp1: [heater, set_value, drum]
  // extratemp2: [fan, ambient_temp, ambient_humidity]
  // Artisan uses placeholders for replayable controls:
  // {3} = heater (type 3, device 141), {0} = fan (type 0, device 139), {1} = drum (type 1, device 140)
  // 'SV' = Set Value (for display purposes, not replayable)
  // 'AT' = Ambient Temperature, 'AH' = Ambient Humidity (non-replayable)
  
  // extratemp1: Heater, Set Value, Drum
  // SV (Set Value) represents the initial bean probe temperature before beans are added (charge temp)
  // This is the temperature reading at the start of the roast, before the beans drop
  const svValue = beanTemp[0];  // First bean temp measurement (pre-charge temperature)
  const svArray = new Array(time.length).fill(svValue);
  
  alogContent += `'extratemp1': [\n`;
  alogContent += `  ${formatPythonArray(heater100)},\n`;
  alogContent += `  ${formatPythonArray(svArray)},\n`;  // SV (Set Value / charge temperature)
  alogContent += `  ${formatPythonArray(drum100)}\n`;
  alogContent += `],\n`;
  
  // extratemp2: Fan, Ambient Temperature, Ambient Humidity
  alogContent += `'extratemp2': [\n`;
  alogContent += `  ${formatPythonArray(fan100)},\n`;
  alogContent += `  ${formatPythonArray(ambientTemp)},\n`;
  alogContent += `  ${formatPythonArray(humidity)}\n`;
  alogContent += `],\n`;
  
  // Extra device IDs - required by Artisan to identify device types
  // 141 = Heater device, 139 = Fan device, 140 = Drum device
  alogContent += `'extradevices': [141, 139, 140],\n`;
  
  // Labels for extra temperature channels with Artisan placeholders for replay
  // extraname1: Heater {3}, Set Value (SV), Drum {1}
  alogContent += `'extraname1': ['{3}', 'SV', '{1}'],\n`;
  // extraname2: Fan {0}, Ambient Temp (AT), Ambient Humidity (AH)
  alogContent += `'extraname2': ['{0}', 'AT', 'AH'],\n`;
  
  // Time arrays for extra temperature channels
  // extratimex contains time arrays for all channels in extratemp1
  alogContent += `'extratimex': [\n`;
  alogContent += `  ${formatPythonArray(time)},\n`;
  alogContent += `  ${formatPythonArray(time)},\n`;
  alogContent += `  ${formatPythonArray(time)}\n`;
  alogContent += `],\n`;
  
  // Time arrays for extratemp2 channels
  alogContent += `'extratimex2': [\n`;
  alogContent += `  ${formatPythonArray(time)},\n`;
  alogContent += `  ${formatPythonArray(time)},\n`;
  alogContent += `  ${formatPythonArray(time)}\n`;
  alogContent += `],\n`;
  
  // Special events: encode control changes as discrete events
  // These are critical for Artisan to display controls properly
  // Format: events occur at time indices (not seconds) into the timex array
  // specialevents: array of indices into timex where events occur
  // specialeventstype: array of event types (0=fan, 1=drum, 3=heater)
  // specialeventsvalue: array of event values (power levels 0-10 scale)
  // specialeventsStrings: array of string labels for events
  // Use the original control profile times (not interpolated) to create proper step functions
  // Note: Pass chargeIndex to offset event indices for pre-charge period
  const specialEvents = generateSpecialEvents(
    time,
    recipe.control_profile.heater.time,
    recipe.control_profile.heater.values,
    recipe.control_profile.fan.time,
    recipe.control_profile.fan.values,
    recipe.control_profile.drum.time,
    recipe.control_profile.drum.values,
    chargeIndex  // Offset for pre-charge period
  );
  
  alogContent += `'specialevents': ${formatPythonIntArray(specialEvents.events)},\n`;
  alogContent += `'specialeventstype': ${formatPythonIntArray(specialEvents.types)},\n`;
  alogContent += `'specialeventsvalue': ${formatPythonArray(specialEvents.values)},\n`;
  alogContent += `'specialeventsStrings': ${formatPythonStringArray(specialEvents.strings)},\n`;
  
  // Event annotations: CHARGE and DROP events
  // Format: [[event_id, time_seconds, ET_temp, time_seconds, BT_temp], ...]
  // CHARGE: event_id = 0 (occurs at chargeTime, the moment beans are added)
  // DROP: event_id = 6 (at last timestep with final temperatures)
  //
  // Important: CHARGE occurs at chargeIndex, NOT at array index 0
  // This is because we prepended pre-charge data before the simulation
  const chargeTimeValue = time[chargeIndex];  // Time when CHARGE occurs (positive value)
  const chargeET = envTemp[chargeIndex];  // ET at CHARGE
  const chargeBT = beanTemp[chargeIndex];  // BT at CHARGE
  const dropTime = time[time.length - 1];  // Time when DROP occurs
  const dropET = envTemp[envTemp.length - 1];  // ET at DROP
  const dropBT = beanTemp[beanTemp.length - 1];  // BT at DROP
  
  alogContent += `'anno_positions': [\n`;
  alogContent += `  [0, ${chargeTimeValue.toFixed(2)}, ${chargeET.toFixed(1)}, ${chargeTimeValue.toFixed(2)}, ${chargeBT.toFixed(1)}],\n`;  // CHARGE event
  alogContent += `  [6, ${dropTime.toFixed(2)}, ${dropET.toFixed(1)}, ${dropTime.toFixed(2)}, ${dropBT.toFixed(1)}]\n`;  // DROP event
  alogContent += `],\n`;
  
  // Labels for events
  alogContent += `'anno_labels': ['CHARGE', 'DROP'],\n`;
  
  // Optional: include target temperature if available
  if (recipe.target_temp_c !== null) {
    alogContent += `'target_temp': ${recipe.target_temp_c},\n`;
  }
  
  // Mark as AutoRoaster generated
  alogContent += `'source': 'AutoRoaster Recipe Export',\n`;
  alogContent += `'recipe_id': '${recipe.id}',\n`;
  
  // Flavor profile ratings (9-element array for different flavor attributes)
  // Default values set to 5.0 for all attributes
  alogContent += `'flavors': [5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0]\n`;
  
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
 * @param heaterTime - Time points for heater control changes (seconds, relative to CHARGE at t=0)
 * @param heaterValues - Heater power values (0-1 scale) at each time point
 * @param fanTime - Time points for fan control changes (seconds, relative to CHARGE at t=0)
 * @param fanValues - Fan speed values (0-1 scale) at each time point
 * @param drumTime - Time points for drum control changes (seconds, relative to CHARGE at t=0)
 * @param drumValues - Drum speed values (0-1 scale) at each time point
 * @param chargeIndexOffset - Index offset for pre-charge period (where t=0 is located in simTime array)
 * @returns Object with parallel arrays for events, types, values, and strings
 */
function generateSpecialEvents(
  simTime: number[],
  heaterTime: number[],
  heaterValues: number[],
  fanTime: number[],
  fanValues: number[],
  drumTime: number[],
  drumValues: number[],
  chargeIndexOffset: number = 0  // Offset for pre-charge period (index where t=0)
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
  // Note: Control profile times are relative to CHARGE (t=0), so we need to
  // offset the resulting index by chargeIndexOffset to account for pre-charge data
  function findTimeIndex(targetTime: number): number {
    // Find the index in simTime that is closest to targetTime
    // Start searching from chargeIndexOffset (where t=0 is located)
    let closestIndex = chargeIndexOffset;
    let minDiff = Math.abs(simTime[chargeIndexOffset] - targetTime);
    
    for (let i = chargeIndexOffset + 1; i < simTime.length; i++) {
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
      // Artisan uses formula: (internal_value * 10) - 10 = displayed_value
      // So we need inverse: internal_value = (displayed_value + 10) / 10
      values.push((heaterValue + 10) / 10);
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
      // Artisan uses formula: (internal_value * 10) - 10 = displayed_value
      // So we need inverse: internal_value = (displayed_value + 10) / 10
      values.push((fanValue + 10) / 10);
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
      // Artisan uses formula: (internal_value * 10) - 10 = displayed_value
      // So we need inverse: internal_value = (displayed_value + 10) / 10
      values.push((drumValue + 10) / 10);
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
