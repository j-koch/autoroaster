/**
 * ALOG File Parser
 * 
 * Parses Artisan .alog files which use Python dict syntax (single quotes)
 * instead of standard JSON format. Based on the AlogRoastDataset implementation
 * from pipeline/dataset.py.
 * 
 * The parser handles:
 * - Time series data extraction (bean temp, environment temp, control signals)
 * - Metadata extraction  
 * - Data validation and cleaning
 * - Event parsing (CHARGE, DROP)
 */

/**
 * Parsed roast data structure
 * Contains time series arrays where each index corresponds to a time point
 */
export interface ParsedRoastData {
    // Time arrays
    timeSeconds: number[];    // Time in seconds from roast start
    timeMinutes: number[];    // Time in minutes for plotting
    
    // Temperature data (°C)
    beanTemp: number[];       // BT - Bean Temperature (temp2 in alog)
    environmentTemp: number[]; // ET - Environment Temperature (temp1 in alog)
    
    // Control signals (0-100 typically)
    heater: number[];         // Heater/burner power (extratemp1[0])
    fan: number[];            // Fan speed (extratemp2[0])
    drum: number[];           // Drum speed (extratemp1[2])
    
    // Environmental conditions
    ambientTemp: number[];    // Ambient temperature (extratemp2[1])
    humidity: number[];       // Relative humidity (extratemp2[2])
    
    // Events
    chargeTime?: number;      // Time in minutes when beans were charged
    dropTime?: number;        // Time in minutes when beans were dropped
    
    // Metadata from the file
    metadata: {
        roastDate?: string;
        beans?: string;
        roastName?: string;
        mass?: number;         // Green bean mass in grams
        [key: string]: any;
    };
    
    // Statistics
    duration: number;         // Total duration in minutes
    maxBeanTemp: number;
    maxEnvTemp: number;
}

/**
 * Parse an Artisan .alog file
 * 
 * The .alog format uses Python dict syntax with single quotes instead of JSON.
 * We need to convert it to valid JSON before parsing.
 * 
 * @param fileContent - The raw text content of the .alog file
 * @returns Parsed roast data structure
 * @throws Error if file is invalid or cannot be parsed
 */
export function parseAlogFile(fileContent: string): ParsedRoastData {
    try {
        // Convert Python dict syntax to JSON
        // Replace single quotes with double quotes, but be careful with escaped quotes
        // and quotes within strings
        let jsonContent = fileContent
            // Replace True/False with true/false
            .replace(/\bTrue\b/g, 'true')
            .replace(/\bFalse\b/g, 'false')
            .replace(/\bNone\b/g, 'null')
            // Replace single quotes with double quotes
            // This is a simplified approach - for production, you'd want a more robust parser
            .replace(/'/g, '"');
        
        // Parse as JSON
        const data = JSON.parse(jsonContent);
        
        // Validate that this is an alog file with expected structure
        if (!data.timex || !Array.isArray(data.timex)) {
            throw new Error('Invalid .alog file: missing timex array');
        }
        
        // Extract time data
        // timex is in seconds from start of roast
        const timeSeconds: number[] = data.timex;
        const timeMinutes: number[] = timeSeconds.map(s => s / 60);
        
        // Extract temperature data
        // temp2 = BT (Bean Temperature), temp1 = ET (Environment Temperature)
        const beanTemp: number[] = data.temp2 || [];
        const environmentTemp: number[] = data.temp1 || [];
        
        // Extract control signals from extratemp arrays
        // Based on AlogRoastDataset implementation:
        // extratemp1[0] = heater/burner
        // extratemp2[0] = fan/air
        // extratemp1[2] = drum speed
        // extratemp2[1] = ambient temperature
        // extratemp2[2] = ambient humidity
        
        const heater: number[] = (data.extratemp1 && data.extratemp1[0]) || 
                                 Array(timeSeconds.length).fill(0);
        const fan: number[] = (data.extratemp2 && data.extratemp2[0]) || 
                              Array(timeSeconds.length).fill(0);
        const drum: number[] = (data.extratemp1 && data.extratemp1[2]) || 
                               Array(timeSeconds.length).fill(0);
        const ambientTemp: number[] = (data.extratemp2 && data.extratemp2[1]) || 
                                       Array(timeSeconds.length).fill(25); // Default 25°C
        const humidity: number[] = (data.extratemp2 && data.extratemp2[2]) || 
                                   Array(timeSeconds.length).fill(50); // Default 50%
        
        // Ensure all arrays have the same length
        const maxLength = timeSeconds.length;
        while (beanTemp.length < maxLength) beanTemp.push(NaN);
        while (environmentTemp.length < maxLength) environmentTemp.push(NaN);
        while (heater.length < maxLength) heater.push(0);
        while (fan.length < maxLength) fan.push(0);
        while (drum.length < maxLength) drum.push(0);
        while (ambientTemp.length < maxLength) ambientTemp.push(25);
        while (humidity.length < maxLength) humidity.push(50);
        
        // Extract mass from weight field [value, decimals, unit]
        let mass: number | undefined = undefined;
        if (data.weight && Array.isArray(data.weight) && data.weight.length > 0) {
            const massValue = parseFloat(data.weight[0]);
            if (!isNaN(massValue) && massValue > 0) {
                mass = massValue;
            }
        }
        
        // Parse events for charge/drop times from anno_positions
        // anno_positions contains [event_type, time_seconds, ...] for each annotation
        // CHARGE: typically event_id <= 0
        // DROP: typically event_id >= 6 (or last event)
        let chargeTimeSeconds: number | undefined = undefined;
        let dropTimeSeconds: number | undefined = undefined;
        
        if (data.anno_positions && Array.isArray(data.anno_positions)) {
            for (const anno of data.anno_positions) {
                if (Array.isArray(anno) && anno.length >= 2) {
                    const eventId = anno[0];
                    const timeSec = anno[1];
                    
                    // CHARGE is typically the first negative or zero event_id
                    if (eventId <= 0 && chargeTimeSeconds === undefined) {
                        chargeTimeSeconds = timeSec;
                    }
                    
                    // DROP is typically the last event with event_id >= 6
                    if (eventId >= 6) {
                        dropTimeSeconds = timeSec;
                    }
                }
            }
        }
        
        // Convert charge and drop times to minutes
        const chargeTime = chargeTimeSeconds !== undefined ? chargeTimeSeconds / 60 : undefined;
        const dropTime = dropTimeSeconds !== undefined ? dropTimeSeconds / 60 : undefined;
        
        // Extract metadata
        const metadata: ParsedRoastData['metadata'] = {};
        
        // Common metadata fields in .alog files
        if (data.roastdate) metadata.roastDate = data.roastdate;
        if (data.beans) metadata.beans = data.beans;
        if (data.title) metadata.roastName = data.title;
        if (mass !== undefined) metadata.mass = mass;
        
        // Calculate statistics
        const validBeanTemps = beanTemp.filter(t => !isNaN(t));
        const validEnvTemps = environmentTemp.filter(t => !isNaN(t));
        
        const maxBeanTemp = validBeanTemps.length > 0 ? Math.max(...validBeanTemps) : 0;
        const maxEnvTemp = validEnvTemps.length > 0 ? Math.max(...validEnvTemps) : 0;
        const duration = timeMinutes.length > 0 ? timeMinutes[timeMinutes.length - 1] : 0;
        
        return {
            timeSeconds,
            timeMinutes,
            beanTemp,
            environmentTemp,
            heater,
            fan,
            drum,
            ambientTemp,
            humidity,
            chargeTime,
            dropTime,
            metadata,
            duration,
            maxBeanTemp,
            maxEnvTemp
        };
        
    } catch (error: any) {
        console.error('Error parsing .alog file:', error);
        throw new Error(`Failed to parse .alog file: ${error.message}`);
    }
}

/**
 * Apply a moving average filter to smooth noisy data
 * 
 * @param data - Array of data points to smooth
 * @param windowSize - Size of the moving average window (must be odd)
 * @returns Smoothed array
 */
function movingAverage(data: number[], windowSize: number): number[] {
    const smoothed: number[] = [];
    const halfWindow = Math.floor(windowSize / 2);
    
    for (let i = 0; i < data.length; i++) {
        // For edge cases, use smaller window
        const start = Math.max(0, i - halfWindow);
        const end = Math.min(data.length - 1, i + halfWindow);
        
        let sum = 0;
        let count = 0;
        
        for (let j = start; j <= end; j++) {
            if (!isNaN(data[j])) {
                sum += data[j];
                count++;
            }
        }
        
        smoothed.push(count > 0 ? sum / count : NaN);
    }
    
    return smoothed;
}

/**
 * Calculate Rate of Rise (RoR) from temperature data with smoothing
 * 
 * RoR is the rate of temperature change (°C per minute). This implementation:
 * 1. First smooths the temperature data to reduce noise
 * 2. Calculates instantaneous rate of change
 * 3. Applies additional smoothing to the RoR values
 * 
 * This two-stage smoothing approach produces much cleaner RoR curves.
 * 
 * @param beanTemp - Array of bean temperatures (°C)
 * @param timeMinutes - Array of time points (minutes)
 * @param tempSmoothWindow - Window size for temperature smoothing (default: 7)
 * @param rorSmoothWindow - Window size for RoR smoothing (default: 9)
 * @returns Array of smoothed RoR values (°C/min)
 */
export function calculateRateOfRise(
    beanTemp: number[],
    timeMinutes: number[],
    tempSmoothWindow: number = 7,
    rorSmoothWindow: number = 9
): number[] {
    if (beanTemp.length < 2) {
        return [];
    }
    
    // Step 1: Smooth the temperature data first
    // This removes high-frequency noise that would create spikes in RoR
    const smoothedTemp = movingAverage(beanTemp, tempSmoothWindow);
    
    // Step 2: Calculate instantaneous RoR from smoothed temperature
    const rawRor: number[] = [];
    
    for (let i = 0; i < smoothedTemp.length; i++) {
        if (i === 0 || isNaN(smoothedTemp[i]) || isNaN(smoothedTemp[i - 1])) {
            // First point or invalid data - no RoR available
            rawRor.push(NaN);
            continue;
        }
        
        const deltaTemp = smoothedTemp[i] - smoothedTemp[i - 1];
        const deltaTime = timeMinutes[i] - timeMinutes[i - 1];
        
        if (deltaTime > 0) {
            // RoR in °C per minute
            rawRor.push(deltaTemp / deltaTime);
        } else {
            rawRor.push(NaN);
        }
    }
    
    // Step 3: Apply additional smoothing to the RoR values
    // This creates the final smooth RoR curve commonly seen in roasting software
    const smoothedRor = movingAverage(rawRor, rorSmoothWindow);
    
    return smoothedRor;
}
