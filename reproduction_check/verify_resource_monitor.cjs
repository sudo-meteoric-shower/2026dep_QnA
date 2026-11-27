const os=require('node:os');
const {spawn}=require('node:child_process');

function cpuTimes(){
  return os.cpus().reduce(({idle,total},{times})=>({
    idle:idle+times.idle,
    total:total+Object.values(times).reduce((sum,value)=>sum+value,0),
  }),{idle:0,total:0});
}

function startResourceMonitor(record, stopTest){
  const started=Date.now();
  const gpu=spawn('nvidia-smi',[
    '--query-gpu=memory.used,memory.free,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits','-l','1'
  ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let previous=cpuTimes(), latestGpu, lowCount=0, stopped=false, buffered='';
  gpu.stdout.setEncoding('utf8');
  gpu.stdout.on('data',chunk=>{
    buffered+=chunk;
    const lines=buffered.split(/\r?\n/);
    buffered=lines.pop();
    for(const line of lines){
      const fields=line.split(',').map(value=>Number(value.trim()));
      if(fields.length===4 && fields.every(Number.isFinite)){
        const [gpuUsedMiB,gpuFreeMiB,gpuPercent,gpuTempC]=fields;
        latestGpu={gpuUsedMiB,gpuFreeMiB,gpuPercent,gpuTempC};
      }
    }
  });
  gpu.on('error',error=>{record.gpuMonitorError=error.message;});
  const timer=setInterval(()=>{
    const current=cpuTimes();
    const elapsed=current.total-previous.total;
    const idle=current.idle-previous.idle;
    previous=current;
    const cpuPercent=elapsed>0?Math.round(100*(elapsed-idle)/elapsed):null;
    const freeRamMiB=Math.round(os.freemem()/2**20);
    const sample={elapsedMs:Date.now()-started,cpuPercent,freeRamMiB,...latestGpu};
    record.samples.push(sample);
    const low=freeRamMiB<4096 || (latestGpu && latestGpu.gpuFreeMiB<1024);
    lowCount=low?lowCount+1:0;
    if(lowCount>=2 && !stopped){
      record.safetyStop=sample;
      stopTest('连续两次资源采样低于保护阈值');
    }
  },1000);
  return ()=>{
    stopped=true;
    clearInterval(timer);
    gpu.kill();
  };
}
module.exports={startResourceMonitor};
