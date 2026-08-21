#!/usr/bin/env python3
"""Apply the current-tree A2 compatibility patch to the reviewed materializer."""

from __future__ import annotations

import ast
import base64
import re
import subprocess
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / ".github/a2-materialize-flow-foreman.py"
PATCH = base64.b85decode('c-q}sTaVnf6@J&RAoeA;XSB|4>?BQ4!-nI;MpI;wY|w|c2sjdFhP5OrqO|J?`s4eZLsGZVT-OcKE@01%JeTiWc+R2XI2Q70E^Ae3nd#qDby;qr*=!~jTi?EXDdI1m&9D9>X71(X%SgNsvMe*5$Xc61$RZWmid1F#PE{%u^|~_6YK<R+F7C9|i%f~K(s!UON>y1?$V_}I7nM#fiQ0FSQpLU8Sn<P8*kWs$Wp*w=O)s^=yQWOB7jKAHCYvHzD=WS=mCC^+@YA&=YDs0Rjmu2dOH<{ZkN8PdpvMHhQTBap%DH&`{X0i;QJH&7zxLEx8(Z7UD1ISsSY%#UR_0EpSc(6NTGx<H$V!PM)A$@`CXw0K5J(B@_|;VdGQt$uhDdqk08)?D(@Cn}Mk2&kuL`VBWGNRq;~y`@?OGAJvQl^2G*;Z3>b)&xqMp89%bJWq+XUeQmZGt0*<@m^ZEXMs&{xE;NYq>`ni|N#f<&+|A~VH`1cwf_tX8TfrPC&<p=h$!wMy!yQkNGO7xQQ~0O!@aSgxQzP-8PEYv<ZpC<)^cb1ayPTv;nux>z~%dr%NXC*{Tq-#U)BBjKtO!r-P^V4EoUrE|r+$!Z-ZYgrU3BYNI3H)5ekH&GjJpi)*uxbwc7;4@z1OL&bU5`U)+UVuId|9q61#6Df}FYy4MJbmmi67+|6FT|54uX-y)sw=#M*k3()(i7s_%-mBv5zC~hDgqQjsTG{ONZG-SsZw2dmCubtqBIW1vm+5Q6TMy}J|GOo3C2ZY8}7lWiRmX6QX*rK4g*+J0sm4&mE1aQDoLuRhFwbMWu|ff%WE%B4saql9pk43IMLY~<0l3<)7u;4X9W21*d2&}B6dUyI5z${`5ch~j*ow)IF$lELj3>u=G8ZUeKXkHB>-CWI1=|2etJ|Xnda)3Qr7Faa33D?F?@CPeE!*$nDOi9d=NXv;?G!zKugpw2IhX`Si0Z3{KI)=Ss8>2d7dB*{{{Yt<zE}sP)w7PiB%;_aPFMP+k>{azkf$F(M4~2b^>@rGP$e`?m-I&yTadH<nmnK?%uLP(eQ4mGZL<r_B~$S!f4`e5Om(fs!U~xBw$-v@tXnNjq~9?y+xz5)HL+AYUogMj_40u^}*$mxHe{(PzI^|4+o{sjDrmLzXGQZD<5x9z1Rp23HWj!8pk+#?5*=^;8Vb*)(IpFd5kQxBm*K**J?h<`mrrlf|D+ZVnAOaYw3`WLpst0XOCUp%j9~8Im;HsZPsGNe_u)WILA=hC?4n7U~rc97Dts5`?*E4lYn^`r=t~{<~DG@zQhB@o0C0|5#Yd}nt*MvCCRIscb6A~4P3j`cE7op>LH@DewI2y4)LzW;jXAQs8NDsnRsge26^0DS4>C{y_M_Q;2ULYd=~FkBwFJ$2>v&zp{h`zJd_J*vDqM#i1%uPa~LLbhh4UDy~}J^4kjiqVR9;Z$@0S*L*Tqz7bY_+a)O0g>mp@sSl^4W#vchtXuMV%0J9GkaU?3y>?l~oK2)OFsjv(j9N&6^x>s`S@M<nMo?p+OqwT+X{>A+B>+{MD-^PTaa;ww}=0L?Inu1!4)SaBXkZQ>&?%R)j6-04R%9LwZ7+CUICNdbspTFWxt9w;3*6pd5Af!ze>e^$dQtj#*3#?p;wX6!9ZeLL)?N4S)$8<D<jeLt6PVnxV)E(}EjzHTxWML0{{7%<zn+5Ca4^vRv*jnYj#WKLJ68CD+$BkMNY6e{$D{~c2WPzg?MjmFkkuBO*GHi+yXhPlMuD-Hsy=X{4v302DI@C0Hfui`~hWr@fu=%6enf4c3=I?vNsrDD!=8t9%vcFFN4s%$V>#Tz*V0TcPdk8?V2d23}i!~pDUo}~n5}-G&;-yT0VHEp4q=YwM|C@diq=aP~QX1*4>nLS|Y*=Z_Y=|jkmb$G}k!iiHdmX0T6v-MnNdM+{S=f>tKF>APuAowQ8Cd3MChNM=Xq%Z7QZ!UU6RyD<t+e_;X%sGTzt+hbpe`$E>#A{WT}W!Jm%+7^#5#j+*m>MAI(=|4u4K`m!2n-|avNeFOJQ#m_s|wSXkAA2@6Da_a!=YD;+&nk42HNo)?(ragCU>}SWKK?FbH?ZVq&+!ytYAVAdgmQt;;hy6*gT%CwyqRXgI;y41lxrK10j}jeWkmxt)tQxlBUihMud|zzrmMGUd)pYQ|J<YSn%ufR+vG8WIqVwxjrF+)jv6ZZf1nH}xt^mGfNy;mf}11r-a*Kaz(kbfQGDBB=>to?F69@KDyT=VI~5<5_j4L<|B1*obOIW=mm~j>IldqIf?l;z&?9E&YC|c<o(S+onRy^=7rC@kCiWbQ3C=USt1<x%i9DwHu*&FsMP2;V7DS4)ktRT6l-xgXvPdA%_oo)Rio3MuT2Z3M1T4&><ii?vzk>E~~*PX4>8qXq>?m$Cd{GSzyH{s!I+i_bN9Bo&Egd_oE*0R3F)g2uV5(i8u!loLM^{5nG5Hwlz-oQ?L>pRO9){aC&ocKFW0Q9<qhpiG&IONLT~x7~^mtkr-U2qZ`UE!*49UvKPnEbHK!uKGUNK2j>VhJ&O}13{{te3v=|k1FGJz6Zs!`=E8Jn25SXPlULy7zF)`$P0EryBX3+8Ir8605l>e-nzh1;2g@4GM#2s}$P;_Wfp*)gUcwlkA{T|Ttev~J{(wlJEKJ?CO{fF6Yg31M#*HnanCgE^{bTM&1H5Z^njFIv%@0-nHU0sY#ik8R*%u^=cS$1l2{JoZdx7d=9U6|@*DhqV26neip36$Bks#qp&<TX>*9~Lc1h#8E&@mt>$c(OD_<Ai2Yn>j0ipl4%{?wM8DJJhZUCo1dd(|lbw{#b0s@`wAI^D$?sz<Yt?t?%HN{=EX-ij1i|B@-xnU9>WPK*iLtnCN$-AvHqwQIpuyKtEPW53Q#hxi&WRN}O?FQt2P>4kmd1#;JU{eC;#8C=YJV(nRWERR;BEwbU4!<6>QI3bzP%WlEcWblF$63PX~?<;5dN@|4sPh2a!`Jn4Z7ZaC(s5Wgq7`b;gNVQGyGge)+7k!R{zvy!x+(qB@)wB8ar($+}eLcUv;>jCPnsO}qzEhdC2QGNM`V{YP!-Q}X=dx_CdEH=xzb9!%w0r5Dsdss{rG}yh<#m{iE)<O%T%;EAPOtn_h3BW}yfW!0_VH-$GR)#1oBG!C0%V!JlOjJu-7dhlWb-%4R8{sIfQCJ#D(J3{+FC7F1w4YUbaK6_LM!VU`GV?439LnU<jU)`S8q!1byFg3b~fbcnA3(baj%Q_ht2<&GJEYh9PI8itV`$9;nCheX7b*bK!+k^=e;mp)yBJS#DZ1g7h>;{1Jw5=vmS>-%O)Y|Twrt`JBbMAuFt-lKf6ZmdiKTq*{7VlPDn8~KmPE|&#!Nzc<>z3jPV&{i+u}sV6yECy|54ye^WA?xc(o-)WT!M+hG*{(9ZT{&T%LcY2SfZ^kcd7Q$4=Q;wmWIW|bLgvGxIhacOcKjmegGg7j>cY)J9wg=~+4V}ja_AGDzUiV8qu+=z#sa%+czG)L@+Ps%+hpf3g=&Usg&al`sir*&MK+0GTLiMuWc1IyrP&W+;fjWmhnnc9Slvh(&TskT!cCJ@JZ<k$mq9?S7urX9~otZ5F@6ho*^3K#W(<Yi6vx_Vn>etj|8>h%dN(|*T0Ogo(8bnHzC*Lm%T6s;eT<4Hafq&qbphl}@xxzAL(Qf~h!PY&2VL@|DX0~DtuIzpOBTeo$IKz*T3vN9DH{EQ$3L1QWT;Z-m0nr15Djvob1p_h1zZ~7CbF7n%~=Eg7GV;<-67)AqM!tBVYJD3N<N$Te_>JJn6hnSYe4a}1U4Q{&ek2iGVC8pI*pjvS|BMrbXCA|STe|NK_ai+Tw@}$N94hz*kqQJ*mV^5hm)WeSsyqD5T*W#Ac&i5WocHO<}X&JiIBn@9zQRBCFbqLjV!!Djom!Df4^wR#Dy}R_}?Io8d9iiQe_R=mVp3vSimzZ9+pTmD|ltA2e4ib9p7<tEuGX!k$0|Z+4IQkE-7N(v')

wrapper = WRAPPER.read_text(encoding="utf-8")
match = re.search(r"b85decode\((?P<literal>'(?:\\.|[^'])*')\)", wrapper, re.DOTALL)
if match is None:
    raise SystemExit("A2 materializer payload literal was not found")
source = zlib.decompress(base64.b85decode(ast.literal_eval(match.group("literal"))))

with tempfile.TemporaryDirectory(prefix="a2-flow-foreman-") as temporary:
    directory = Path(temporary)
    materializer = directory / "materializer.py"
    patch_file = directory / "current-tree.patch"
    materializer.write_bytes(source)
    patch_file.write_bytes(zlib.decompress(PATCH))
    subprocess.run(
        ["patch", "--batch", "--forward", "-p1", "-i", str(patch_file)],
        cwd=directory,
        check=True,
    )
    patched = materializer.read_bytes()

compile(patched, f"{WRAPPER}:current-tree", "exec")
exec(
    compile(patched, f"{WRAPPER}:current-tree", "exec"),
    {"__file__": str(Path(__file__).resolve()), "__name__": "__main__"},
)
