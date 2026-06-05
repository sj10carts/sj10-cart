// config/s3Client.js
const { S3Client } = require("@aws-sdk/client-s3");
require('dotenv').config();

const s3Client = new S3Client({
    region: "auto",
    endpoint: process.env.CF_ENDPOINT, 
    credentials: {
        accessKeyId: process.env.CF_ACCESS_KEY_ID,
        secretAccessKey: process.env.CF_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true 
});

module.exports = s3Client;