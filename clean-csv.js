const fs = require('fs');
const path = require('path');

const inputFile = path.join(process.cwd(), 'unicorns.csv');
const outputFile = path.join(process.cwd(), 'unicorns_clean.csv');

// Read the file
const content = fs.readFileSync(inputFile, 'utf8');
const lines = content.split('\n');

// Remove first 3 lines (headers) and last 6 lines (footer)
const cleanedLines = lines.slice(3, -6);

// Write the cleaned content
fs.writeFileSync(outputFile, cleanedLines.join('\n'));

console.log('CSV file cleaned successfully!'); 