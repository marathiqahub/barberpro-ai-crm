'use strict';
const MAX_MESSAGE_LENGTH=500,MAX_HISTORY_MESSAGES=8;
function normalizeConversation(history,message){
 if(typeof message!=='string'||!message.trim()||message.trim().length>MAX_MESSAGE_LENGTH)throw new TypeError('message is required and must be 1–500 characters.');
 if(history!==undefined&&!Array.isArray(history))throw new TypeError('conversation must be an array of recent messages.');
 const normalized=(history||[]).slice(-MAX_HISTORY_MESSAGES).map(entry=>{
  if(!entry||!['user','assistant'].includes(entry.role)||typeof entry.content!=='string'||!entry.content.trim()||entry.content.length>MAX_MESSAGE_LENGTH)throw new TypeError('Each conversation entry must have a user/assistant role and 1–500 characters of text.');
  return {role:entry.role,content:entry.content.trim()};
 });
 normalized.push({role:'user',content:message.trim()});return normalized;
}
module.exports={normalizeConversation,MAX_MESSAGE_LENGTH,MAX_HISTORY_MESSAGES};
