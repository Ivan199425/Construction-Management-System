// Cloudflare Email Worker — hand the whole message to the inbound-email function.
//
// This is not deployed with the Supabase function; it lives in Cloudflare. Create an Email
// Worker, paste this in, and set two variables under Settings -> Variables:
//
//   ENDPOINT   https://vzxenkijxzzrgnmopnxh.supabase.co/functions/v1/inbound-email
//   KEY        the INBOUND_KEY secret  (add this one as a secret, not a plain text variable)
//
// Then route invoices@... to this worker under Email Routing -> Routing rules.

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();

    // message.to is the envelope recipient — the address the mail was actually delivered to.
    // It is passed along because the To: header is unreliable: on a forward it names somebody
    // else entirely, and the function uses this to decide whether the address is one of ours.
    const url = env.ENDPOINT + '?key=' + encodeURIComponent(env.KEY)
              + '&to=' + encodeURIComponent(message.to || '');

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'message/rfc822' },
      body: raw,
    });

    if (!res.ok) {
      // Refusing the message tells the sending server to try again later, and it will. That is
      // far better than accepting an invoice and dropping it: a supplier who gets a bounce
      // rings up, whereas silence is discovered at the end of the month.
      message.setReject('Could not accept this message right now — please try again shortly');
    }
  },
};
