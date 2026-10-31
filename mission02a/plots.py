"""Static figures for the local Markdown diagnostic report."""
import os
from pathlib import Path
os.environ.setdefault('MPLCONFIGDIR',str(Path(__file__).parent/'evidence/matplotlib'))
os.environ.setdefault('XDG_CACHE_HOME',str(Path(__file__).parent/'evidence/cache'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import pandas as pd
import numpy as np
from mission02a.diagnostics import OUT,ROOT


def main():
    report=ROOT/'mission02a/reports'
    report.mkdir(exist_ok=True)
    colors={'baseline':'#7a8491','catboost':'#007d82','part1_engine':'#9d4d9d'}
    labels={'baseline':'Mission 01 baseline','catboost':'Mission 01 CatBoost','part1_engine':'Part 1 reference engine'}
    c=pd.read_csv(OUT/'coverage_macro_metrics.csv')
    c=c.loc[c.split.eq('test') & c.truth.eq('no_stockout_proxy') & c.origin_cohort.eq('common_7day_origins')]
    fig,ax=plt.subplots(figsize=(9,5))
    for name,marker in [('baseline','s'),('catboost','o'),('part1_engine','^')]:
        f=c.loc[c.model.eq(name)].sort_values('cover_days')
        ax.plot(f.cover_days,f.macro_WAPE*100,marker=marker,label=labels[name],color=colors[name],lw=2)
        if name=='catboost':
            for r in f.itertuples():ax.annotate(f'{r.macro_WAPE:.2%}',(r.cover_days,r.macro_WAPE*100),xytext=(8,-19),textcoords='offset points',color=colors[name])
    ax.set(xticks=[1,2,3,7],ylim=(0,43),xlabel='Cover days, including forecast origin',ylabel='Mean series WAPE (%)',title='Longer windows reduce relative error, but do not remove it')
    ax.grid(axis='y',alpha=.2);ax.legend(loc='upper right',frameon=False)
    fig.text(.11,.01,'Synthetic data | Same 55 origins: Aug 1-Sep 24, 2026 | 63 active store-ingredient series\nTruth: observed consumption + lost demand adjusted for past cancellation rate',fontsize=9)
    fig.tight_layout(rect=[0,.08,1,1]);fig.savefig(report/'coverage.png',dpi=170);plt.close(fig)
    d=pd.read_csv(OUT/'daily_store_ingredient_metrics.csv')
    d=d.loc[d.split.eq('test') & d.truth.eq('no_stockout_proxy') & d.model.eq('catboost')]
    ids=['I009','I020','I017'];names=['I009 Lettuce','I020 Toast bread','I017 Coleslaw']
    fig,axes=plt.subplots(1,2,figsize=(11,5))
    x=np.arange(3)
    for j,store in enumerate(['S01','S02','S03']):
        f=d.loc[d.store_id.eq(store)].set_index('ingredient_id').loc[ids]
        for ax,col in zip(axes,['WAPE','Bias']):
            bars=ax.bar(x+(j-1)*.24,f[col]*100,width=.24,label=store,color=['#007d82','#b97816','#9d4d9d'][j])
            ax.bar_label(bars,fmt='%.1f',fontsize=9,padding=3)
    for ax in axes:ax.set(xticks=x,xticklabels=names);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True)
    axes[0].set(ylabel='WAPE (%)',ylim=(0,85),title='Relative error is largest for toast bread')
    axes[1].set(ylabel='Bias (%)',ylim=(-10,23),title='Error direction differs by item and store');axes[1].axhline(0,color='#555',lw=.8)
    axes[0].legend(frameon=False)
    fig.text(.08,.01,'Synthetic data | Daily h=0, Aug-Sep 2026, n=61 per series | CatBoost | Exploratory items selected after full-period EDA',fontsize=9)
    fig.tight_layout(rect=[0,.05,1,1]);fig.savefig(report/'focus.png',dpi=170);plt.close(fig)
    f=pd.read_csv(OUT/'daily_diagnostic_rows.csv',parse_dates=['target_date'])
    f=f.loc[f.split.eq('test')]
    fig,axes=plt.subplots(3,2,figsize=(12,9),sharex=True)
    for i,(item,name,unit,scale) in enumerate([('I009','Lettuce','kg',1000),('I020','Toast bread','slices',1),('I017','Coleslaw','kg',1000)]):
        ymax=max(f.loc[f.ingredient_id.eq(item)&f.store_id.isin(['S02','S03']),['consumed_qty','pred_catboost']].max())/scale*1.08
        for j,store in enumerate(['S02','S03']):
            sub=f.loc[f.store_id.eq(store)&f.ingredient_id.eq(item)].sort_values('target_date');ax=axes[i,j]
            ax.plot(sub.target_date,sub.consumed_qty/scale,label='Observed consumed',color='#647181',lw=1.2)
            ax.plot(sub.target_date,sub.pred_catboost/scale,label='CatBoost expected use',color='#007d82',lw=1.6)
            ax.set(title=f'{store} | {item} {name}',ylabel=unit,ylim=(0,ymax));ax.grid(alpha=.15)
    axes[0,0].legend(frameon=False,fontsize=9)
    for ax in axes[-1]:ax.tick_params(axis='x',rotation=25)
    fig.suptitle('Daily errors in S02 and S03; scales are shared within each ingredient',fontsize=13)
    fig.text(.08,.01,'Synthetic data | Aug-Sep 2026 | Fixed pre-Test model, history updated strictly before each origin | No prediction intervals fitted',fontsize=9)
    fig.tight_layout(rect=[0,.04,1,.97]);fig.savefig(report/'focus_daily.png',dpi=150);plt.close(fig)


if __name__=='__main__':main()
