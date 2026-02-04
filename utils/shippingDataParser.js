// utils/shippingDataParser.js

const parseShippingData = (packageInfo) => {
    // Default fallback values (Standard flyer size)
    const defaults = { length: 12, width: 10, height: 2, weight: 0.5 };
    
    if (!packageInfo || typeof packageInfo !== 'string') return defaults;

    try {
        const lowerInfo = packageInfo.toLowerCase();

        // 1. Extract Weight using Regex (looks for numbers before kg/g)
        // Matches: "0.5kg", "500g", "weight: 1.2 kg"
        let weight = defaults.weight;
        const kgMatch = lowerInfo.match(/(\d+(\.\d+)?)\s*kg/);
        const gMatch = lowerInfo.match(/(\d+(\.\d+)?)\s*g/);

        if (kgMatch) {
            weight = parseFloat(kgMatch[1]);
        } else if (gMatch) {
            weight = parseFloat(gMatch[1]) / 1000;
        } else {
            // Fallback: look for just a floating number if no unit found? 
            // Better to stick to default to avoid "12x12" being read as 12kg
        }

        // 2. Extract Dimensions
        // Matches standard formats like "12x10x5" or "12*10*5"
        let length = defaults.length;
        let width = defaults.width;
        let height = defaults.height;

        // Regex for "Number x Number x Number"
        const dimsMatch = lowerInfo.match(/(\d+(\.\d+)?)\s*[x*]\s*(\d+(\.\d+)?)\s*[x*]\s*(\d+(\.\d+)?)/);

        if (dimsMatch) {
            length = parseFloat(dimsMatch[1]);
            width = parseFloat(dimsMatch[3]);
            height = parseFloat(dimsMatch[5]);
        }

        return { length, width, height, weight };

    } catch (error) { 
        console.error("Shipping Parser Error:", error);
        return defaults; 
    }
};

module.exports = { parseShippingData };