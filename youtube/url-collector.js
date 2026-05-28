#!/usr/bin/env node

/**
 * Connect AI YouTube URL Collector
 * 
 * YouTube URL 수집 파이프라인 - 대량 URL 처리 및 큐브 시스템
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class YouTubeURLCollector {
  constructor(vaultPath = null) {
    this.vaultPath = vaultPath || '/mnt/c/Users/mjb58/connect-ai-vault';
    this.queuePath = path.join(this.vaultPath, 'youtube', 'queue');
    this.processedPath = path.join(this.vaultPath, 'youtube', 'processed');
    this.initDirectories();
  }

  initDirectories() {
    [this.queuePath, this.processedPath].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * YouTube URL 큐에 추가
   * @param {string|Array} urls - YouTube URL 또는 URL 배열
   * @param {Object} metadata - 추가 메타데이터
   */
  addToQueue(urls, metadata = {}) {
    const urlArray = Array.isArray(urls) ? urls : [urls];
    const timestamp = new Date().toISOString();
    
    const queueItems = urlArray.map(url => {
      const id = this.generateURLId(url);
      return {
        id,
        url,
        timestamp,
        status: 'queued',
        metadata
      };
    });

    // 큐 파일에 저장
    const queueFile = path.join(this.queuePath, `batch-${timestamp.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(queueFile, JSON.stringify(queueItems, null, 2));
    
    console.log(`Added ${urlArray.length} URLs to queue: ${queueFile}`);
    return queueFile;
  }

  /**
   * 큐에서 다음 처리할 URL 가져오기
   */
  getNextFromQueue() {
    const queueFiles = fs.readdirSync(this.queuePath)
      .filter(file => file.endsWith('.json'))
      .sort();

    for (const queueFile of queueFiles) {
      const queueFilePath = path.join(this.queuePath, queueFile);
      const queueData = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
      
      const pendingItem = queueData.find(item => item.status === 'queued');
      if (pendingItem) {
        return {
          ...pendingItem,
          queueFile,
          queueFilePath
        };
      }
    }

    return null;
  }

  /**
   * URL 처리 상태 업데이트
   * @param {string} queueFile - 큐 파일명
   * @param {string} urlId - URL ID
   * @param {string} status - 새 상태
   * @param {Object} result - 처리 결과
   */
  updateURLStatus(queueFile, urlId, status, result = {}) {
    const queueFilePath = path.join(this.queuePath, queueFile);
    const queueData = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
    
    const itemIndex = queueData.findIndex(item => item.id === urlId);
    if (itemIndex !== -1) {
      queueData[itemIndex].status = status;
      queueData[itemIndex].updated = new Date().toISOString();
      
      if (result) {
        queueData[itemIndex].result = result;
      }

      fs.writeFileSync(queueFilePath, JSON.stringify(queueData, null, 2));
      
      // 처리 완료된 경우 processed로 이동
      if (status === 'completed' || status === 'failed') {
        this.moveToProcessed(queueFile, urlId, queueData[itemIndex]);
      }
    }
  }

  /**
   * 처리된 항목을 processed 디렉토리로 이동
   */
  moveToProcessed(queueFile, urlId, item) {
    const processedFile = path.join(this.processedPath, `${urlId}.json`);
    fs.writeFileSync(processedFile, JSON.stringify(item, null, 2));
  }

  /**
   * URL ID 생성
   */
  generateURLId(url) {
    return crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
  }

  /**
   * YouTube URL 유효성 검사
   */
  isValidYouTubeURL(url) {
    const patterns = [
      /^https?:\/\/(www\.)?youtube\.com\/watch\?v=/,
      /^https?:\/\/youtu\.be\//,
      /^https?:\/\/(www\.)?youtube\.com\/embed\//
    ];
    
    return patterns.some(pattern => pattern.test(url));
  }

  /**
   * 큐 상태 조회
   */
  getQueueStatus() {
    const queueFiles = fs.readdirSync(this.queuePath)
      .filter(file => file.endsWith('.json'));

    let totalQueued = 0;
    let totalProcessing = 0;
    let totalCompleted = 0;
    let totalFailed = 0;

    queueFiles.forEach(queueFile => {
      const queueFilePath = path.join(this.queuePath, queueFile);
      const queueData = JSON.parse(fs.readFileSync(queueFilePath, 'utf8'));
      
      queueData.forEach(item => {
        switch (item.status) {
          case 'queued':
            totalQueued++;
            break;
          case 'processing':
            totalProcessing++;
            break;
          case 'completed':
            totalCompleted++;
            break;
          case 'failed':
            totalFailed++;
            break;
        }
      });
    });

    return {
      total: totalQueued + totalProcessing + totalCompleted + totalFailed,
      queued: totalQueued,
      processing: totalProcessing,
      completed: totalCompleted,
      failed: totalFailed
    };
  }

  /**
   * 대량 URL import (파일에서)
   */
  importFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const urls = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && this.isValidYouTubeURL(line));

    if (urls.length === 0) {
      throw new Error('No valid YouTube URLs found in file');
    }

    return this.addToQueue(urls, { source: 'file', filename: path.basename(filePath) });
  }
}

// CLI 인터페이스
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const collector = new YouTubeURLCollector();

  switch (command) {
    case 'add':
      if (args.length < 2) {
        console.error('Usage: node url-collector.js add <url1,url2,...> [metadata]');
        process.exit(1);
      }
      
      const urls = args[1].split(',').map(url => url.trim());
      const metadata = args[2] ? JSON.parse(args[2]) : {};
      
      collector.addToQueue(urls, metadata);
      break;

    case 'import':
      if (args.length < 2) {
        console.error('Usage: node url-collector.js import <file>');
        process.exit(1);
      }
      
      try {
        collector.importFromFile(args[1]);
      } catch (error) {
        console.error('Import failed:', error.message);
        process.exit(1);
      }
      break;

    case 'status':
      console.log('Queue Status:', collector.getQueueStatus());
      break;

    case 'next':
      const next = collector.getNextFromQueue();
      if (next) {
        console.log('Next URL:', JSON.stringify(next, null, 2));
      } else {
        console.log('No URLs in queue');
      }
      break;

    default:
      console.log(`
Connect AI YouTube URL Collector

Usage:
  node url-collector.js add <url1,url2,...> [metadata]  - Add URLs to queue
  node url-collector.js import <file>                    - Import URLs from file
  node url-collector.js status                           - Show queue status
  node url-collector.js next                             - Get next URL from queue

Examples:
  node url-collector.js add "https://youtu.be/dQw4w9WgXcQ"
  node url-collector.js import urls.txt
  node url-collector.js add "url1,url2,url3" '{"source":"manual"}'
      `);
      break;
  }
}

module.exports = YouTubeURLCollector;
