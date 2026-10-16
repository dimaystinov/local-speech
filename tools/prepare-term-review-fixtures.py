"""Fresh synthetic technical/homophone diagnostics; not human quality evidence."""
import argparse,hashlib,json,subprocess,wave
from pathlib import Path
import numpy as np
MIXED=[
 'Запусти Docker и проверь контейнер после обновления.',
 'Проверь Kubernetes перед переносом базы данных.',
 'Открой GitHub и найди последний запрос на изменение.',
 'Сборка GitLab должна завершиться без ошибок.',
 'Сначала обнови Postgres, а затем сделай резервную копию.',
 'Проверь Redis, но не удаляй сохранённые ключи.',
 'Этот скрипт написан на Python и работает локально.',
 'Исправь JavaScript в обработчике событий.',
 'Добавь TypeScript в новый проект.',
 'Компонент React должен обновляться после ответа сервера.',
 'Проверь WebSocket после повторного подключения.',
 'Для распознавания используем Whisper на компьютере.',
 'Сравни Zipformer с текущей моделью распознавания.',
 'Добавь метрики в Prometheus после развёртывания.',
 'Открой Grafana и посмотри задержку запросов.',
 'Проверь Terraform перед изменением инфраструктуры.',
 'Запусти Ansible только на тестовом сервере.',
 'Обнови Elasticsearch после создания резервной копии.',
 'Проверь MongoDB перед запуском миграции.',
 'Не меняй Docker, пока не закончится проверка Python.'
]
RUSSIAN=[
 'Свежий редис лежит на кухонном столе.',
 'Большой питон спокойно лежит в террариуме.',
 'Опытный докер разгружает корабль в порту.',
 'Сначала проверь договор, потом отправляй письмо.',
 'Не удаляй резервную копию и не меняй пароль.',
 'Заказчик попросил перенести встречу на завтра.',
 'В корзине лежат морковь, редис и огурцы.',
 'Этот питон питается один раз в неделю.',
 'Работа докера требует осторожности и внимания.',
 'Исполнитель должен проверить результат самостоятельно.',
 'Мне нужен полный текст разговора без сокращений.',
 'Сегодня обсуждаем расписание, а не программу.'
]
def main():
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();root=a.output.resolve();root.mkdir(parents=True,exist_ok=True)
 if (root/'corpus.json').exists():raise ValueError('Frozen fixtures already exist')
 cases=[];rng=np.random.default_rng(20261016)
 for i,text in enumerate(MIXED+RUSSIAN):
  name=f'term-fixture-{i:02d}';aiff=root/(name+'.aiff');wav=root/(name+'.wav')
  subprocess.run(['say','-v','Milena','-r','175','-o',str(aiff),text],check=True)
  subprocess.run(['afconvert','-f','WAVE','-d','LEI16@16000','-c','1',str(aiff),str(wav)],check=True)
  with wave.open(str(wav)) as f:audio=np.frombuffer(f.readframes(f.getnframes()),dtype='<i2').astype(np.float32)/32768
  for condition in (['clean','noise15db'] if i<len(MIXED) else ['clean']):
   path=wav
   if condition!='clean':
    noise=rng.standard_normal(len(audio));noise*=np.sqrt(np.mean(audio**2)/10**1.5)/np.sqrt(np.mean(noise**2));x=np.clip(audio+noise,-1,.9999);path=root/(name+'-'+condition+'.wav')
    with wave.open(str(path),'wb') as f:f.setnchannels(1);f.setsampwidth(2);f.setframerate(16000);f.writeframes((x*32767).astype('<i2').tobytes())
   cases.append(dict(id=name+'-'+condition,file=str(path),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),reference=text,terms=__import__('re').findall('[A-Za-z]+',text),language='mixed' if i<len(MIXED) else 'ru',variant='synthetic-'+condition,group=name,split='holdout',durationSeconds=len(audio)/16000))
 (root/'corpus.json').write_text(json.dumps(dict(cases=cases,synthetic=True,seed=20261016,limitation='macOS Milena, shared voice; noise is paired, not independent human evidence'),ensure_ascii=False,indent=2));print('fixtures',len(cases))
if __name__=='__main__':main()
