#!/usr/bin/env node

/**
 * Connect AI YouTube Content Processor
 * 
 * YouTube URL 처리 및 콘텐츠 분석 - Hermes 연동
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const URLCollector = require('./url-collector');

class YouTubeProcessor {
  constructor(vaultPath = null) {
    this.vaultPath = vaultPath || '/mnt/c/Users/mjb58/connect-ai-vault';
    this.collector = new URLCollector(vaultPath);
    this.contentPath = path.join(this.vaultPath, 'youtube', 'content');
    this.initDirectories();
  }

  initDirectories() {
    if (!fs.existsSync(this.contentPath)) {
      fs.mkdirSync(this.contentPath, { recursive: true });
    }
  }

  /**
   * 다음 URL 처리
   */
  async processNext() {
    const nextURL = this.collector.getNextFromQueue();
    
    if (!nextURL) {
      console.log('No URLs to process');
      return null;
    }

    console.log(`Processing URL: ${nextURL.url}`);
    
    // 상태 업데이트
    this.collector.updateURLStatus(nextURL.queueFile, nextURL.id, 'processing');

    try {
      // Hermes를 통한 YouTube ingest (수정: -z 옵션 사용)
      const result = await this.ingestURL(nextURL.url);
      
      // 성공 처리
      this.collector.updateURLStatus(nextURL.queueFile, nextURL.id, 'completed', result);
      
      console.log(`Successfully processed: ${nextURL.url}`);
      return result;
      
    } catch (error) {
      console.error(`Failed to process ${nextURL.url}:`, error.message);
      
      // 실패 처리
      this.collector.updateURLStatus(nextURL.queueFile, nextURL.id, 'failed', {
        error: error.message
      });
      
      throw error;
    }
  }

  /**
   * Hermes를 통한 YouTube URL ingest (수정)
   */
  async ingestURL(url) {
    return new Promise((resolve, reject) => {
      const prompt = `Please analyze the YouTube video ${url} and provide a comprehensive summary in Korean. Include key points, insights, and actionable takeaways.`;
      
      const hermes = spawn('hermes', ['-z', prompt], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      hermes.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      hermes.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      hermes.on('close', (code) => {
        if (code === 0) {
          resolve({
            url,
            summary: stdout.trim(),
            processedAt: new Date().toISOString()
          });
        } else {
          reject(new Error(`Hermes failed with code ${code}: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to spawn hermes: ${error.message}`));
      });
    });
  }

  /**
   * 배치 처리
   */
  async processBatch(limit = 5) {
    const results = [];
    let processed = 0;

    while (processed < limit) {
      try {
        const result = await this.processNext();
        if (result) {
          results.push(result);
          processed++;
        } else {
          break; // No more URLs
        }
      } catch (error) {
        console.error(`Batch processing error:`, error.message);
        // Continue with next URL
        processed++;
      }
    }

    return results;
  }

  /**
   * 처리된 콘텐츠 목록 조회
   */
  getProcessedContent() {
    if (!fs.existsSync(this.contentPath)) {
      return [];
    }

    const files = fs.readdirSync(this.contentPath)
      .filter(file => file.endsWith('.json'));

    return files.map(file => {
      const filePath = path.join(this.contentPath, file);
      const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      return {
        file,
        path: filePath,
        url: content.url,
        processedAt: content.processedAt,
        size: fs.statSync(filePath).size
      };
    });
  }

  /**
   * 콘텐츠 생성 요청 (Claude/Codex 위임)
   */
  async generateContent(urlId, contentType = 'summary') {
    const processedFile = path.join(this.collector.processedPath, `${urlId}.json`);
    
    if (!fs.existsSync(processedFile)) {
      throw new Error(`Processed content not found: ${urlId}`);
    }

    const processedData = JSON.parse(fs.readFileSync(processedFile, 'utf8'));
    const url = processedData.url;

    // Hermes를 통한 콘텐츠 생성 위임
    const prompt = this.buildContentPrompt(url, contentType);
    
    return new Promise((resolve, reject) => {
      const hermes = spawn('hermes', ['-z', prompt], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      hermes.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      hermes.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      hermes.on('close', (code) => {
        if (code === 0) {
          resolve({
            urlId,
            contentType,
            content: stdout.trim(),
            generatedAt: new Date().toISOString()
          });
        } else {
          reject(new Error(`Content generation failed: ${stderr.trim()}`));
        }
      });

      hermes.on('error', (error) => {
        reject(new Error(`Failed to spawn hermes: ${error.message}`));
      });
    });
  }

  /**
   * 콘텐츠 생성 프롬프트 빌드
   */
  buildContentPrompt(url, contentType) {
    const prompts = {
      summary: `Please analyze the YouTube content from ${url} and generate a comprehensive summary in Korean. Include key points, insights, and actionable takeaways.`,
      transcript: `Please extract and format the transcript from ${url} in Korean. Include timestamps and speaker identification if available.`,
      analysis: `Please provide a detailed analysis of the YouTube content from ${url} in Korean. Include topic analysis, audience engagement, and content quality assessment.`
    };

    return prompts[contentType] || prompts.summary;
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const processor = new YouTubeProcessor();

  switch (command) {
    case 'process':
      processor.processNext()
        .then(result => {
          if (result) {
            console.log('Processing completed:', JSON.stringify(result, null, 2));
          }
        })
        .catch(error => {
          console.error('Processing failed:', error.message);
          process.exit(1);
        });
      break;

    case 'batch':
      const limit = parseInt(args[1]) || 5;
      processor.processBatch(limit)
        .then(results => {
          console.log(`Batch processing completed. Processed ${results.length} URLs.`);
          results.forEach((result, index) => {
            console.log(`\nResult ${index + 1}:`, JSON.stringify(result, null, 2));
          });
        })
        .catch(error => {
          console.error('Batch processing failed:', error.message);
          process.exit(1);
        });
      break;

    case 'list':
      console.log('Processed Content:', processor.getProcessedContent());
      break;

    case 'generate':
      if (args.length < 2) {
        console.error('Usage: node processor.js generate <urlId> [contentType]');
        process.exit(1);
      }
      
      processor.generateContent(args[1], args[2])
        .then(result => {
          console.log('Generated content:', JSON.stringify(result, null, 2));
        })
        .catch(error => {
          console.error('Content generation failed:', error.message);
          process.exit(1);
        });
      break;

    default:
      console.log(`
Connect AI YouTube Content Processor

Usage:
  node processor.js process                    - Process next URL from queue
  node processor.js batch [limit]             - Process batch of URLs
  node processor.js list                      - List processed content
  node processor.js generate <urlId> [type]   - Generate content from processed URL

Content types:
  summary    - Generate summary (default)
  transcript - Extract transcript
  analysis   - Detailed analysis

Examples:
  node processor.js process
  node processor.js batch 3
  node processor.js generate be9f3392 summary
      `);
      break;
  }
}

module.exports = YouTubeProcessor;
