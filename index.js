// Conservative first release: hook handles read-only, explicitly opt-in Telegram status.
// GPU creation/destruction are restricted to the operator CLI, never Telegram messages.
import {spawn} from 'node:child_process';
export default {
  id:'colab-provisioner',name:'Colab Provisioner (Community Beta)',
  register(api){
    const cfg={mode:'observe',telegramCommands:false,allowedTelegramIds:[],...(api.pluginConfig??{})};
    api.logger.info('[colab-provisioner] loaded; GPU operations require local operator CLI');
    api.on('before_dispatch',async(event,ctx)=>{
      if(!cfg.telegramCommands || cfg.mode!=='manual')return;
      if(String(ctx?.channelId??event?.channel??'')!=='telegram'||event?.isGroup)return;
      const message=String(event?.content??event?.body??'').trim();
      if(!/^!colab\s+(help|status)$/i.test(message))return;
      const id=String(ctx?.senderId??event?.senderId??'').replace(/^telegram:/,'');
      if(!cfg.allowedTelegramIds.includes(id))return;
      const target=String(ctx?.conversationId??ctx?.senderId??'').replace(/^telegram:/,'');
      if(!/^-?\d+$/.test(target))return;
      const reply='Colab Provisioner installed. GPU operations are operator-only. Run colabctl specs, list, create or delete on the Gateway host.';
      // No shell, no model invocation. Explicit send is required by some OpenClaw runtimes.
      await new Promise(resolve=>{
        const child=spawn('openclaw',['message','send','--channel','telegram','--target',target,'--message',reply],{stdio:'ignore'});
        const timer=setTimeout(()=>child.kill('SIGTERM'),15000);timer.unref();
        child.on('error',e=>{clearTimeout(timer);api.logger.warn(`[colab-provisioner] delivery error ${e.message}`);resolve();});
        child.on('close',code=>{clearTimeout(timer);if(code!==0)api.logger.warn(`[colab-provisioner] delivery exit=${code}`);resolve();});
      });
      return {handled:true};
    });
  }
};
