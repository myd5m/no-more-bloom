const fs = require('fs');
const path = require('path');

let CONFIG = {
    scanDelayMs: 2000,
    fileBatchSize: 20,
    fileBatchDelayMs: 500,
    yieldInterval: 25,
    memoryCheckInterval: 20,
    maxMemoryUsageMB: 150,
    resourceBatchSize: 2,
    forceGCInterval: 10,
    maxFileSizeMB: 3,
    fileReadTimeout: 5000
};

function adaptConfigToResourceCount(resourceCount) {
    if (resourceCount <= 100) {
        return {
            scanDelayMs: 2000,
            fileBatchSize: 40,
            fileBatchDelayMs: 200,
            yieldInterval: 75,
            memoryCheckInterval: 40,
            maxMemoryUsageMB: 200,
            resourceBatchSize: 8,
            batchCooldownMs: 3000,
            forceGCInterval: 8,
            maxFileSizeMB: 5,
            fileReadTimeout: 8000,
            mode: 'FAST'
        };
    } else if (resourceCount <= 300) {
        return {
            scanDelayMs: 4000,
            fileBatchSize: 25,
            fileBatchDelayMs: 400,
            yieldInterval: 50,
            memoryCheckInterval: 30,
            maxMemoryUsageMB: 180,
            resourceBatchSize: 5,
            batchCooldownMs: 6000,
            forceGCInterval: 6,
            maxFileSizeMB: 4,
            fileReadTimeout: 6000,
            mode: 'BALANCED'
        };
    } else if (resourceCount <= 600) {
        return {
            scanDelayMs: 8000,
            fileBatchSize: 20,
            fileBatchDelayMs: 600,
            yieldInterval: 30,
            memoryCheckInterval: 20,
            maxMemoryUsageMB: 150,
            resourceBatchSize: 3,
            batchCooldownMs: 12000,
            forceGCInterval: 4,
            maxFileSizeMB: 3,
            fileReadTimeout: 5000,
            mode: 'CAREFUL'
        };
    } else {
        return {
            scanDelayMs: 12000,
            fileBatchSize: 15,
            fileBatchDelayMs: 800,
            yieldInterval: 20,
            memoryCheckInterval: 15,
            maxMemoryUsageMB: 120,
            resourceBatchSize: 2,
            batchCooldownMs: 20000,
            forceGCInterval: 3,
            maxFileSizeMB: 2,
            fileReadTimeout: 4000,
            mode: 'EXTREME_SAFE'
        };
    }
}

const sleep = (ms) => new Promise(resolve => {
    if (ms === 0) return setImmediate(resolve);
    const start = Date.now();
    const timer = setInterval(() => {
        if (Date.now() - start >= ms) {
            clearInterval(timer);
            resolve();
        }
    }, Math.min(ms, 10));
});

function getMemoryUsageMB() {
    try {
        const usage = process.memoryUsage();
        return Math.round(usage.heapUsed / 1024 / 1024);
    } catch {
        return 0;
    }
}

async function checkMemoryAndYield() {
    const memMB = getMemoryUsageMB();
    if (memMB > CONFIG.maxMemoryUsageMB) {
        console.log(`Memory high (${memMB}MB), forcing cleanup...`);
        if (global.gc) {
            global.gc();
            await sleep(1500);
            global.gc();
        }
        await sleep(2000);
    } else if (memMB > CONFIG.maxMemoryUsageMB * 0.85) {
        if (global.gc) global.gc();
        await sleep(500);
    } else {
        await sleep(0);
    }
}

let resourcesProcessed = 0;
async function forcePeriodicCleanup() {
    resourcesProcessed++;
    if (resourcesProcessed % CONFIG.forceGCInterval === 0) {
        console.log(`Periodic cleanup (${resourcesProcessed} resources processed)...`);
        if (global.gc) {
            global.gc();
            await sleep(2000);
        }
        await sleep(1000);
    }
}

function getRootPath() {
    const resourcePath = GetResourcePath("monitor");
    if (!resourcePath) return null;
    const match = resourcePath.match(/^(.*?)[\\/]+monitor$/);
    return match ? match[1] : null;
}

const rootPath = getRootPath();
const allowedResources = ['chat', 'monitor'];

function listDirectories(dirPath) {
    if (!dirPath) return [];
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    } catch (error) {
        console.log("Error reading directory:", error.message);
        return [];
    }
}

const unauthorizedResources = rootPath ? listDirectories(rootPath).filter(dir => !allowedResources.includes(dir)) : [];
if (unauthorizedResources.length > 0) {
    console.log("Unauthorized system resources: ", unauthorizedResources.join(', '));
}
function deleteFolderRecursive(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            try {
                entry.isDirectory() ? deleteFolderRecursive(fullPath) : fs.unlinkSync(fullPath);
            } catch {}
        }
        fs.rmdirSync(dirPath);
    } catch {}
}

function deleteDirectoryContent(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        let count = 0;
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            try {
                entry.isDirectory() ? deleteFolderRecursive(fullPath) : fs.unlinkSync(fullPath);
                count++;
            } catch {}
        }
        return count;
    } catch {
        return 0;
    }
}

async function scanForInfection(dirPath, resourceName, resourcePath) {
    const infectedFiles = [];
    let fileCount = 0;
    let lastMemCheck = 0;
    
    const patterns = [
        new RegExp(`^\\/\\*\\s*\\[\\s*${resourceName}\\s*\\]\\s*\\*\\/`),
        new RegExp(`^\\/\\*\\s*\\[${resourceName}\\]\\s*\\*\\/`),
        /globalThis\s*\[\s*x\s*\(\s*['"]/i,
        /globalThis\s*\[\s*\w+\s*\(\s*['"]/i,
        /globalThis\s*\[.*\(.*["']/i,
        /function\s+_\w+\s*\([^)]*\)\s*\{[^}]*replace\s*\(\s*\/\\u\(\[0-9a-f\]\{4\}\)\/g/i,
        /\.replace\s*\(\s*\/\\u\(\[0-9a-f\]\{4\}\)\/g/i,
        /String\.fromCharCode\s*\([^)]*parseInt\s*\([^)]*16\s*\)/i,
        /const\s+\w+\s*=\s*["'][^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}/i,
        /function\s+_\w+\s*\([^)]*\)\s*\{[^}]*\.split\s*\(['"]\s*['"]\)\s*\.map\s*\([^}]*charCodeAt\s*\([^)]*\)\s*\^\s*\w+/i,
        /globalThis\s*\[\s*_\w+\s*\([^)]*\)\s*\]/i,
        /const\s+_\w+\s*=\s*\d+\s*;\s*function\s+_\w+\s*\([^)]*\)\s*\{[^}]*replace.*\\u.*fromCharCode/i,
        /\.map\s*\([^}]*charCodeAt\s*\([^)]*\)\s*\^\s*\w+\s*\)/i,
        /["'][^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}/i,
        /const\s+_\w+\s*=\s*["'][^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}[^"']*\\u[0-9a-f]{4}/i,
        /\\u[0-9a-f]{4}\\u[0-9a-f]{4}\\u[0-9a-f]{4}\\u[0-9a-f]{4}\\u[0-9a-f]{4}\\u[0-9a-f]{4}\\u[0-9a-f]{4}\\u[0-9a-f]{4}/i,
        /(\\u[0-9a-f]{4}){10,}/i,
        /\\u0025\\u0025\\u0025\\u0025\\u0025\\u0025/i,
        /["'][^"']*(\\u[0-9a-f]{4}[^"']*){15,}/i
    ];
    
    async function scanDirectory(dir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    await scanDirectory(fullPath);
                } else if (entry.name.endsWith('.js')) {
                    fileCount++;
                    
                    if (fileCount % CONFIG.yieldInterval === 0) {
                        await sleep(0);
                    }
                    
                    if (fileCount - lastMemCheck >= CONFIG.memoryCheckInterval) {
                        await checkMemoryAndYield();
                        lastMemCheck = fileCount;
                    }
                    
                    if (fileCount % CONFIG.fileBatchSize === 0) {
                        await sleep(CONFIG.fileBatchDelayMs);
                    }
                    
                    try {
                        const stats = fs.statSync(fullPath);
                        const maxSize = (CONFIG.maxFileSizeMB || 3) * 1024 * 1024;
                        
                        if (stats.size > maxSize) {
                            if (stats.size > 10 * 1024 * 1024) {
                                console.log(`Skipping large file (${Math.round(stats.size/1024/1024)}MB): ${path.basename(fullPath)}`);
                            }
                            continue;
                        }
                        
                        let content;
                        try {
                            content = fs.readFileSync(fullPath, 'utf8');
                        } catch (readErr) {
                            console.log(`Failed to read: ${path.basename(fullPath)}`);
                            continue;
                        }
                        
                        const trimmed = content.trimStart().substring(0, 100);
                        let fullContent = content;
                        if (content.length > 5000) {
                            fullContent = content.substring(0, 3000) + '\n' + content.substring(content.length - 2000);
                        }
                        
                        const isInfectedByHeader = patterns.slice(0, 2).some(p => p.test(trimmed));
                        const isInfectedByObfuscation = patterns.slice(2).some(p => p.test(fullContent));
                        
                        if (isInfectedByHeader || isInfectedByObfuscation) {
                            infectedFiles.push({
                                file: fullPath,
                                resource: resourceName,
                                resourcePath,
                                relativePath: path.relative(resourcePath, fullPath).replace(/\\/g, '/'),
                                preview: content.substring(0, 200)
                            });
                        }
                        
                        content = null;
                    } catch (err) {
                        console.log(`Error scanning ${path.basename(fullPath)}: ${err.message}`);
                    }
                }
            }
        } catch {}
    }
    
    await scanDirectory(dirPath);
    return infectedFiles;
}

(async () => {
    const startTime = Date.now();
    console.log("Scanning for Blum backdoor...");

    const mainResourcesPath = GetResourcePath(GetCurrentResourceName());
    const baseResourcesPath = mainResourcesPath.match(/^(.*?)[\\/]+resources[\\/]+/);

    if (!baseResourcesPath || !baseResourcesPath[1]) {
        console.log("Error: Could not determine resources folder path");
        return;
    }

    const resourcesFolder = path.join(baseResourcesPath[1], 'resources');
    
    async function scanAllResources(dir) {
        const allInfected = [];
        const resourcePaths = [];
        const resourcesToScan = [];
        
        function countResources(currentDir, depth = 0) {
            if (depth > 10) return;
            try {
                const entries = fs.readdirSync(currentDir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    
                    const fullPath = path.join(currentDir, entry.name);
                    
                    if (fs.existsSync(path.join(fullPath, 'fxmanifest.lua'))) {
                        resourcesToScan.push({ path: fullPath, name: entry.name });
                    }
                    
                    countResources(fullPath, depth + 1);
                }
            } catch {}
        }
        
        console.log("Analyzing server structure...");
        countResources(dir);
        const totalResources = resourcesToScan.length;
        
        CONFIG = adaptConfigToResourceCount(totalResources);
        
        console.log(`Found ${totalResources} resource(s) - Mode: ${CONFIG.mode}`);
        console.log(`Config: Scan delay=${CONFIG.scanDelayMs}ms, Batch=${CONFIG.fileBatchSize} files, Memory limit=${CONFIG.maxMemoryUsageMB}MB`);
        console.log(`^Process will be VERY slow to prevent crashes (estimated time: ${Math.round(totalResources * CONFIG.scanDelayMs / 60000)} minutes)`);
        
        const batchSize = CONFIG.resourceBatchSize;
        let processedCount = 0;
        
        for (let batchStart = 0; batchStart < totalResources; batchStart += batchSize) {
            const batch = resourcesToScan.slice(batchStart, batchStart + batchSize);
            
            for (const { path: fullPath, name: resourceName } of batch) {
                processedCount++;
                const progress = Math.floor((processedCount / totalResources) * 100);
                const memUsage = getMemoryUsageMB();
                
                console.log(`[${progress}%] [Mem: ${memUsage}MB] Scanning: ${resourceName}...`);
                
                const infected = await scanForInfection(fullPath, resourceName, fullPath);
                if (infected.length > 0) {
                    console.log(`${infected.length} infected file(s) found`);
                    for (const inf of infected) {
                        console.log(`└─ ${inf.relativePath}`);
                    }
                    allInfected.push(...infected);
                    if (!resourcePaths.includes(fullPath)) {
                        resourcePaths.push(fullPath);
                    }
                } else {
                    console.log(`Clean`);
                }
                
                if (processedCount < totalResources) {
                    await sleep(CONFIG.scanDelayMs);
                }

                await checkMemoryAndYield();
                
                await forcePeriodicCleanup();
            }
            
            if (batchStart + batchSize < totalResources) {
                const cooldown = CONFIG.batchCooldownMs || (CONFIG.scanDelayMs * 2);
                const memBefore = getMemoryUsageMB();
                
                if (memBefore > 50 && global.gc) {
                    console.log(`Batch completed. Cooling down for ${cooldown/1000}s (Memory: ${memBefore}MB)...`);
                    global.gc();
                    await sleep(800);
                    global.gc();
                    await sleep(cooldown - 800);
                    const memAfter = getMemoryUsageMB();
                    console.log(`Cleanup done (Memory: ${memBefore}MB → ${memAfter}MB)`);
                } else {
                    console.log(`Batch completed. Pausing ${cooldown/1000}s...`);
                    await sleep(cooldown);
                }
            }
        }
        
        console.log(`Scanned ${totalResources} resource(s)`);
        return { infected: allInfected, resources: resourcePaths };
    }
    
    const scanResult = await scanAllResources(resourcesFolder);
    const infectedFiles = scanResult.infected;
    const infectedResourcePaths = scanResult.resources;
    
    if (infectedFiles.length > 0) {
        const infectedByResource = infectedFiles.reduce((acc, inf) => {
            (acc[inf.resource] = acc[inf.resource] || []).push(inf);
            return acc;
        }, {});
        
        console.log(`${infectedFiles.length} infected file(s) found in ${Object.keys(infectedByResource).length} resource(s)`);
        
        for (const [resourceName, files] of Object.entries(infectedByResource)) {
            console.log(`${resourceName}: ${files.map(f => f.relativePath).join(', ')}`);
        }

        console.log("Cleaning...");
        
        let deletedCount = 0;
        let failedCount = 0;
        
        for (let i = 0; i < infectedFiles.length; i++) {
            const infected = infectedFiles[i];
            const progress = Math.floor(((i + 1) / infectedFiles.length) * 100);
            
            try {
                fs.unlinkSync(infected.file);
                deletedCount++;
                console.log(`  [${progress}%] Deleted: ${infected.resource}/${infected.relativePath}`);
            } catch (err) {
                failedCount++;
                console.log(`  [${progress}%] Failed: ${infected.resource}/${infected.relativePath} (${err.message})`);
            }
            
            if (i > 0 && i % (CONFIG.yieldInterval * 2) === 0) {
                await checkMemoryAndYield();
            }
        }
        
        console.log(`Cleaning manifests...`);
    
        for (const resourcePath of infectedResourcePaths) {
            const fxmanifestPath = path.join(resourcePath, 'fxmanifest.lua');
            
            try {
                if (!fs.existsSync(fxmanifestPath)) continue;
                
                let content = fs.readFileSync(fxmanifestPath, 'utf8');
                const originalContent = content;
                
                const resourceInfected = infectedFiles.filter(f => f.resourcePath === resourcePath);
                const pathsToRemove = new Set(resourceInfected.map(inf => inf.relativePath.replace(/\\/g, '/')));
                
                content = content.split('\n')
                    .filter(line => !Array.from(pathsToRemove).some(p => 
                        line.includes(p) || line.includes(p.replace(/\//g, '\\'))))
                    .join('\n')
                    .replace(/(shared_scripts|client_scripts|server_scripts)\s*\{\s*\}/g, '')
                    .replace(/\n{3,}/g, '\n\n');
                
                if (content !== originalContent) {
                    fs.writeFileSync(fxmanifestPath, content, 'utf8');
                    console.log(`Cleaned: ${path.basename(resourcePath)}/fxmanifest.lua`);
                }
            } catch (err) {
                console.log(`Failed: ${path.basename(resourcePath)}/fxmanifest.lua (${err.message})`);
            }
            await sleep(0);
        }
        
        console.log(`Removed ${deletedCount}/${infectedFiles.length} infected file(s)${failedCount > 0 ? ` (${failedCount} failed)` : ''}, cleaned ${infectedResourcePaths.length} manifest(s)`);
        
    } else {
        console.log("No infected files detected");
    }

    if (unauthorizedResources.length > 0 && rootPath) {
        console.log("Cleaning system resources...");
        
        let deletedCount = 0;
        
        for (const resourceName of unauthorizedResources) {
            const resourcePath = path.join(rootPath, resourceName);
            
            try {
                const itemsDeleted = deleteDirectoryContent(resourcePath);
                
                try {
                    fs.rmdirSync(resourcePath);
                    console.log(`${resourceName} ${itemsDeleted > 0 ? `(${itemsDeleted} item(s) removed, folder deleted)` : '(empty folder deleted)'}`);
                } catch {
                    console.log(`${resourceName} ${itemsDeleted > 0 ? `(${itemsDeleted} item(s) removed, folder kept empty)` : '(already cleared)'}`);
                }
                deletedCount++;
            } catch (err) {
                console.log(`${resourceName} (${err.message})`);
            }
            await sleep(0);
        }
        
        console.log(`Cleaned ${deletedCount} system resource(s)`);
    }
    
    const totalTime = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(totalTime / 60);
    const seconds = totalTime % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    
    console.log("\n^2========================================");
    console.log("Server cleaned successfully!");
    console.log(`Total time: ${timeStr}`);
    console.log(`Final memory usage: ${getMemoryUsageMB()}MB`);
    console.log("========================================^0\n");
})().catch(err => {
    console.log("Fatal Error:", err.message);
});