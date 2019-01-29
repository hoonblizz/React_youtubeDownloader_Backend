/**
 * Copyright 2016, Google, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// [START functions_http_content]
const escapeHtml = require('escape-html');
const process = require('process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const ytdl = require('ytdl-core');
var FFmpeg = require('fluent-ffmpeg');

const {Storage} = require('@google-cloud/storage');
const storage = new Storage();
const Multer = require('multer');
const format = require('util').format;

// 클라우드 스토리지 세팅
const multer = Multer({
  storage: Multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // no larger than 5mb, you can change as needed.
  },
});
// A bucket is a container for objects (files).
const bucket = storage.bucket('youtube-temp-storage');

// 딥카피 해주는 트릭
function clone(a) {
  return JSON.parse(JSON.stringify(a));
}
// 내 코드 시작
// 사용자가 이미 url 을 갖고 있을때, 정보만 리턴해 주는것.
exports.youtubeGetVideoInfo = (req, res) => {

  console.log('\nVideo URL received: \n' + req.body);

  let parsedJson = JSON.parse(req.body);

  // 자꾸 CORS 때문에 API가 안불러지는 에러가 발생. 거기에 대한 해결
  res.set('Access-Control-Allow-Origin', "*");
  res.set('Access-Control-Allow-Methods', 'PUT');
  res.set('Access-Control-Allow-Headers', 'Content-Type', 'Origin', 'X-Requested-With', 'Accept');

  if(!parsedJson.hasOwnProperty('videoUrl')) res.sendStatus(500);

  ytdl.getInfo(parsedJson.videoUrl, function(err, info){

    let videoInfo = {};
    videoInfo.videoUrl = parsedJson.videoUrl;

    // qualityLabel 가 들어있는 애들만 솎아내주자.
    var videosInfoArr = clone(info.player_response.streamingData.adaptiveFormats);
    let newVideosInfoArr = [];
    videosInfoArr.forEach(el => {
      if(el.hasOwnProperty('qualityLabel')) newVideosInfoArr.push(el);
    });

    videoInfo.videos = newVideosInfoArr;

    // 제일 큰 사이즈의 썸네일 URL만 골라내 주자
    var thumbnailsArr = clone(info.player_response.videoDetails.thumbnail.thumbnails);
    let thumbnailURL = ''; var currBiggestWidth = 0;
    thumbnailsArr.forEach(el => {
      if(el.width > currBiggestWidth) {
        currBiggestWidth = el.width;
        thumbnailURL = el.url;
      }
    });

    videoInfo.thumbnail = thumbnailURL;

    // 타이틀, 길이 등 자잘한 정보 넣기
    videoInfo.title = info.player_response.videoDetails.title.replace('|','').replace(' ','_').toString('ascii');
    videoInfo.length = info.player_response.videoDetails.lengthSeconds;


    console.log('\nVideo Info: \n' + JSON.stringify(videoInfo));

    res.status(200).json(videoInfo);

  });
}
// 사용자가 원하는 비디오 포멧을 선택해서 다운로드를 하려할때,
exports.youtubeCreateDownloadLink = (req, res) => {

  //var url= 'https://www.youtube.com/watch?v=vTIIMJ9tUc8';
  //Temp directory
  let dir = os.tmpdir();
  console.log("converting...into " + dir);

  var videoReadableStream = ytdl(url, {
    filter: 'audioandvideo',
    quality: 18
  });

  // getInfo 는 그냥 이름 얻을라고 부르는거. 실질적인 다운로드는 ytdl 에서 이루어진다.
  // 비디오 사이즈는 bitrate 를 이용해서 계산한다. bitrate x length
  ytdl.getInfo(url, function(err, info){
     var videoName = info.title.replace('|','').replace(' ','').toString('ascii');
     var firstFormatVideoInfo = info.player_response.streamingData.formats[0];
     var approxSize = (firstFormatVideoInfo.averageBitrate / 1000000) *
                      (firstFormatVideoInfo.approxDurationMs / 1000);

     console.log('Video Name: ' + videoName +
                  ', Length: ' + info.length_seconds +
                  ', Thumbnail URL: ' + info.thumbnail_url +
                  ', First format size: ' + approxSize.toFixed(2) + 'MB');

     let filename = videoName + '.mp4';
     const filepath = path.join(dir, filename);

     var videoWritableStream = fs.createWriteStream(filepath);
     var stream = videoReadableStream.pipe(videoWritableStream);

     let starttime;
     var dataRead = 0;

     // data 와 end 는 Readable 에만 해당되고,
     // finish 는 Writable 에만 해당되기 때문에, 다른 스트림에 on 을 붙여준다.
     videoReadableStream.on('response', function(res) {
       var totalSize = res.headers['content-length'];
       var dataRead = 0;
       res.on('data', function(data) {
         dataRead += data.length;
         var percent = dataRead / totalSize;
         //process.stdout.cursorTo(0);
         //process.stdout.clearLine(1);
         console.log('Progress: ' + (percent * 100).toFixed(2) + '% ');
         //res.write('Progress: ' + (percent * 100).toFixed(2) + '% ');
       });
       res.on('end', function() {
         console.log('End signal\n');
       });
     });

     stream.on('finish', function() {
       console.log('Stream finish signal!!');
       //res.writeHead(204);
       //res.end();

       // Then get all files in function
       fs.readdir(dir, (err, files) => {
         if (err) {
           console.error(err);
           //res.sendStatus(500);
         } else {
           console.log('Files', files);
           //res.sendStatus(200);

           // Upload to Google cloud Storage
           // Create a new blob in the bucket and upload the file data.
           const blob = bucket.file(filename);

           // 읽기 스트림 먼저 만들고, 그 다음 스토리지 쓰기 스트림 부른다
           fs.createReadStream(filepath)
           .pipe(blob.createWriteStream({
             resumable: false,
           }))
           .on('error', err => {
             console.log(err);
             res.sendStatus(500);
           })
           .on('finish', () => {
             console.log('To Storage Done. ' + bucket.name + ', ' + blob.name);
             // The public URL can be used to directly access the file via HTTP.

             const publicUrl =
             'https://storage.googleapis.com/' +
             bucket.name + '/' + blob.name;

             console.log('Public Url: ' + publicUrl);
             res.sendStatus(200);
           });

         }
       });
     });


   });

  /*
  var data;


  var stream = ytdl(url, { filter: function(format) { return format.container === "mp4"; }, quality: 'highest'});
  stream.on("info", function(info) {
    data = './' + info.title + '.mp3';
    var proc = new FFmpeg({ source: stream })
      .withAudioCodec("libmp3lame")
      .toFormat("mp3")
      .saveToFile(data, function(stdout, stderr) {
        res.status(200).send('Youtube downloader ran okay!');
      });
  });
  //console.log("done");
  */

  //res.status(200).send('Youtube downloader ran okay!');
}

// 코드 끝

/**
 * Responds to an HTTP request using data from the request body parsed according
 * to the "content-type" header.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.helloContent = (req, res) => {
  let name;

  switch (req.get('content-type')) {
    // '{"name":"John"}'
    case 'application/json':
      name = req.body.name;
      break;

    // 'John', stored in a Buffer
    case 'application/octet-stream':
      name = req.body.toString(); // Convert buffer to a string
      break;

    // 'John'
    case 'text/plain':
      name = req.body;
      break;

    // 'name=John' in the body of a POST request (not the URL)
    case 'application/x-www-form-urlencoded':
      name = req.body.name;
      break;
  }

  res.status(200).send(`Hello ${escapeHtml(name || 'World')}!`);
};
// [END functions_http_content]

// [START functions_http_method]
function handleGET(req, res) {
  // Do something with the GET request
  res.status(200).send('Hello World!');
}

function handlePUT(req, res) {
  // Do something with the PUT request
  res.status(403).send('Forbidden!');
}

/**
 * Responds to a GET request with "Hello World!". Forbids a PUT request.
 *
 * @example
 * gcloud functions call helloHttp
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.helloHttp = (req, res) => {
  switch (req.method) {
    case 'GET':
      handleGET(req, res);
      break;
    case 'PUT':
      handlePUT(req, res);
      break;
    default:
      res.status(405).send({error: 'Something blew up!'});
      break;
  }
};
// [END functions_http_method]

// [START functions_http_xml]
/**
 * Parses a document of type 'text/xml'
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.parseXML = (req, res) => {
  // Convert the request to a Buffer and a string
  // Use whichever one is accepted by your XML parser
  let data = req.rawBody;
  let xmlData = data.toString();

  const parseString = require('xml2js').parseString;

  parseString(xmlData, (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).end();
      return;
    }
    res.send(result);
  });
};
// [END functions_http_xml]

// [START functions_http_form_data]
/**
 * Parses a 'multipart/form-data' upload request
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */

// Node.js doesn't have a built-in multipart/form-data parsing library.
// Instead, we can use the 'busboy' library from NPM to parse these requests.
const Busboy = require('busboy');

exports.uploadFile = (req, res) => {
  if (req.method === 'POST') {
    const busboy = new Busboy({headers: req.headers});
    const tmpdir = os.tmpdir();

    // This object will accumulate all the fields, keyed by their name
    const fields = {};

    // This object will accumulate all the uploaded files, keyed by their name.
    const uploads = {};

    // This code will process each non-file field in the form.
    busboy.on('field', (fieldname, val) => {
      // TODO(developer): Process submitted field values here
      console.log(`Processed field ${fieldname}: ${val}.`);
      fields[fieldname] = val;
    });

    let fileWrites = [];

    // This code will process each file uploaded.
    busboy.on('file', (fieldname, file, filename) => {
      // Note: os.tmpdir() points to an in-memory file system on GCF
      // Thus, any files in it must fit in the instance's memory.
      console.log(`Processed file ${filename}`);
      const filepath = path.join(tmpdir, filename);
      uploads[fieldname] = filepath;

      const writeStream = fs.createWriteStream(filepath);
      file.pipe(writeStream);

      // File was processed by Busboy; wait for it to be written to disk.
      const promise = new Promise((resolve, reject) => {
        file.on('end', () => {
          writeStream.end();
        });
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      fileWrites.push(promise);
    });

    // Triggered once all uploaded files are processed by Busboy.
    // We still need to wait for the disk writes (saves) to complete.
    busboy.on('finish', () => {
      Promise.all(fileWrites).then(() => {
        // TODO(developer): Process saved files here
        for (const name in uploads) {
          const file = uploads[name];
          fs.unlinkSync(file);
        }
        res.send();
      });
    });

    busboy.end(req.rawBody);
  } else {
    // Return a "method not allowed" error
    res.status(405).end();
  }
};
// [END functions_http_form_data]

// [START functions_http_signed_url]

/**
 * HTTP function that generates a signed URL
 * The signed URL can be used to upload files to Google Cloud Storage (GCS)
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.getSignedUrl = (req, res) => {
  if (req.method === 'POST') {
    // TODO(developer) check that the user is authorized to upload

    // Get a reference to the destination file in GCS
    const file = storage.bucket(req.body.bucket).file(req.body.filename);

    // Create a temporary upload URL
    const expiresAtMs = Date.now() + 300000; // Link expires in 5 minutes
    const config = {
      action: 'write',
      expires: expiresAtMs,
      contentType: req.body.contentType,
    };

    file.getSignedUrl(config, function(err, url) {
      if (err) {
        console.error(err);
        res.status(500).end();
        return;
      }
      res.send(url);
    });
  } else {
    // Return a "method not allowed" error
    res.status(405).end();
  }
};
// [END functions_http_signed_url]

// [START functions_http_cors]
/**
 * HTTP function that supports CORS requests.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.corsEnabledFunction = (req, res) => {
  // Set CORS headers for preflight requests
  // Allows GETs from any origin with the Content-Type header
  // and caches preflight response for 3600s

  res.set('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    // Send response to OPTIONS requests
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
  } else {
    // Set CORS headers for the main request
    res.set('Access-Control-Allow-Origin', '*');
    res.send('Hello World!');
  }
};
// [END functions_http_cors]

// [START functions_http_cors_auth]
/**
 * HTTP function that supports CORS requests with credentials.
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
exports.corsEnabledFunctionAuth = (req, res) => {
  // Set CORS headers for preflight requests
  // Allows GETs from origin https://mydomain.com with Authorization header

  res.set('Access-Control-Allow-Origin', 'https://mydomain.com');
  res.set('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    // Send response to OPTIONS requests
    res.set('Access-Control-Allow-Methods', 'GET');
    res.set('Access-Control-Allow-Headers', 'Authorization');
    res.set('Access-Control-Max-Age', '3600');
    res.status(204).send('');
  } else {
    res.send('Hello World!');
  }
};
// [END functions_http_cors_auth]
