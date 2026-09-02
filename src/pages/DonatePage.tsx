export default function DonatePage() {
  return (
    <div>
      <div className="page-h">
        <div>
          <h1>捐赠</h1>
          <div className="desc">
            开源不易，感谢支持。软件完全本地运行、免费使用，是否捐赠不影响任何功能。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="donate-grid">
          <div className="qr-card">
            <div className="qr-title">微信支付</div>
            <img src="/donate/wechat.jpg" alt="微信收款码" style={{ width: 140, borderRadius: 6 }} />
            <div className="qr-sub">打开微信 → 扫一扫</div>
          </div>

          <div className="qr-card">
            <div className="qr-title">支付宝</div>
            <img src="/donate/alipay.jpg" alt="支付宝收款码" style={{ width: 140, borderRadius: 6 }} />
            <div className="qr-sub">打开支付宝 → 扫一扫</div>
          </div>
        </div>
      </div>
    </div>
  );
}
