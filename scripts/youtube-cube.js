#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const envPaths = require("./env-paths.js");

class YouTubeCube {
    constructor() {
        this.repoRoot = envPaths.repoRoot();
        this.runtimePath = envPaths.companyDir();
        this.queueDir = path.join(this.runtimePath, "youtube-queue");
        this.processedDir = path.join(this.runtimePath, "youtube-processed");
        this.scriptsDir = path.join(this.repoRoot, "scripts");
        this.ensureDirectories();
    }

    ensureDirectories() {
        [this.queueDir, this.processedDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    addUrl(url, priority = "normal") {
        const id = this.generateId();
        const timestamp = new Date().toISOString();
        const queueFile = path.join(this.queueDir, `${id}.json`);
        
        const item = {
            id,
            url,
            priority,
            status: "queued",
            timestamp,
            metadata: {
                added_by: "hermes",
                department: "youtube"
            }
        };

        fs.writeFileSync(queueFile, JSON.stringify(item, null, 2));
        console.log(`Added YouTube URL to queue: ${id}`);
        return id;
    }

    processQueue() {
        const queueFiles = fs.readdirSync(this.queueDir).filter(f => f.endsWith('.json'));
        const sortedQueue = queueFiles
            .map(f => {
                const content = fs.readFileSync(path.join(this.queueDir, f), 'utf8');
                return JSON.parse(content);
            })
            .sort((a, b) => {
                const priorityOrder = { high: 3, normal: 2, low: 1 };
                return priorityOrder[b.priority] - priorityOrder[a.priority];
            });

        if (sortedQueue.length === 0) {
            console.log("No items in YouTube queue");
            return;
        }

        const nextItem = sortedQueue[0];
        this.processItem(nextItem);
    }

    async processItem(item) {
        console.log(`Processing YouTube item: ${item.id}`);
        
        try {
            // Update status to processing
            this.updateItemStatus(item.id, "processing");
            
            // Run youtube-ingest.js
            const result = await this.runYouTubeIngest(item.url);
            
            if (result.success) {
                // Move to processed
                this.moveToProcessed(item.id, result);
                console.log(`Successfully processed: ${item.id}`);
            } else {
                this.updateItemStatus(item.id, "failed", result.error);
                console.error(`Failed to process: ${item.id} - ${result.error}`);
            }
        } catch (error) {
            this.updateItemStatus(item.id, "failed", error.message);
            console.error(`Error processing ${item.id}:`, error);
        }
    }

    runYouTubeIngest(url) {
        return new Promise((resolve) => {
            const child = spawn("node", [path.join(this.scriptsDir, "youtube-ingest.js"), url], {
                cwd: this.repoRoot,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (data) => {
                stdout += data.toString();
            });

            child.stderr.on("data", (data) => {
                stderr += data.toString();
            });

            child.on("close", (code) => {
                if (code === 0) {
                    resolve({ success: true, output: stdout });
                } else {
                    resolve({ success: false, error: stderr || `Exit code: ${code}` });
                }
            });
        });
    }

    updateItemStatus(id, status, error = null) {
        const queueFile = path.join(this.queueDir, `${id}.json`);
        if (fs.existsSync(queueFile)) {
            const content = fs.readFileSync(queueFile, 'utf8');
            const item = JSON.parse(content);
            item.status = status;
            if (error) item.error = error;
            item.last_updated = new Date().toISOString();
            fs.writeFileSync(queueFile, JSON.stringify(item, null, 2));
        }
    }

    moveToProcessed(id, result) {
        const queueFile = path.join(this.queueDir, `${id}.json`);
        const processedFile = path.join(this.processedDir, `${id}.json`);
        
        if (fs.existsSync(queueFile)) {
            const content = fs.readFileSync(queueFile, 'utf8');
            const item = JSON.parse(content);
            item.status = "completed";
            item.processed_at = new Date().toISOString();
            item.result = result;
            
            fs.writeFileSync(processedFile, JSON.stringify(item, null, 2));
            fs.unlinkSync(queueFile);
        }
    }

    generateId() {
        return crypto.randomBytes(8).toString('hex');
    }

    getStatus() {
        const queueFiles = fs.readdirSync(this.queueDir).filter(f => f.endsWith('.json'));
        const processedFiles = fs.readdirSync(this.processedDir).filter(f => f.endsWith('.json'));
        
        const queueItems = queueFiles.map(f => {
            const content = fs.readFileSync(path.join(this.queueDir, f), 'utf8');
            return JSON.parse(content);
        });

        const processedItems = processedFiles.map(f => {
            const content = fs.readFileSync(path.join(this.processedDir, f), 'utf8');
            return JSON.parse(content);
        });

        return {
            queue: queueItems,
            processed: processedItems,
            summary: {
                queued: queueItems.length,
                processing: queueItems.filter(i => i.status === 'processing').length,
                completed: processedItems.length,
                failed: processedItems.filter(i => i.status === 'failed').length
            }
        };
    }
}

// CLI interface
function main() {
    const cube = new YouTubeCube();
    const command = process.argv[2];

    switch (command) {
        case "add":
            if (!process.argv[3]) {
                console.error("Usage: youtube-cube.js add <url> [priority]");
                process.exit(1);
            }
            const url = process.argv[3];
            const priority = process.argv[4] || "normal";
            cube.addUrl(url, priority);
            break;

        case "process":
            cube.processQueue();
            break;

        case "status":
            const status = cube.getStatus();
            console.log(JSON.stringify(status, null, 2));
            break;

        default:
            console.log("YouTube Cube - URL Queue Management");
            console.log("Commands:");
            console.log("  add <url> [priority]  - Add URL to queue");
            console.log("  process               - Process next item in queue");
            console.log("  status                - Show queue status");
            break;
    }
}

if (require.main === module) {
    main();
}

module.exports = YouTubeCube;
